import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ConvexClient } from 'convex/browser';

import {
  createInitialSnapshot,
  type CellValue,
  type GameSnapshot,
  type PlayerSymbol,
} from './tic-tac-toe';
import { environment } from '../../../environments/environment';
import { api } from '../../../../convex/_generated/api';

type PlayerRole = 'host' | 'guest' | null;
type RoomStartMode = 'auto' | 'guest';
type ConnectionState =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';
type PeerPresence = 'none' | 'connected' | 'disconnected';

interface RoomView {
  roomId: string;
  snapshot: GameSnapshot;
  role: PlayerRole;
  playerSymbol: PlayerSymbol | null;
  hostOccupied: boolean;
  guestOccupied: boolean;
  hostLastSeenAt: number | null;
  guestLastSeenAt: number | null;
  updatedAt: number;
}

type QuerySubscription = ReturnType<ConvexClient['onUpdate']>;

@Injectable({ providedIn: 'root' })
export class GameRoomService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly browser = isPlatformBrowser(this.platformId);
  private readonly heartbeatIntervalMs = 4_000;
  private readonly heartbeatTimeoutMs = 12_000;
  private readonly storagePrefix = 'drop-games:room-player:';

  private client: ConvexClient | null = null;
  private participantId: string | null = null;
  private roomSubscription: QuerySubscription | null = null;
  private heartbeatIntervalId: number | null = null;
  private presenceIntervalId: number | null = null;
  private shuttingDown = false;

  private readonly roomIdSignal = signal('');
  private readonly roleSignal = signal<PlayerRole>(null);
  private readonly playerSymbolSignal = signal<PlayerSymbol | null>(null);
  private readonly connectionStateSignal = signal<ConnectionState>('idle');
  private readonly snapshotSignal = signal<GameSnapshot>(createInitialSnapshot());
  private readonly errorMessageSignal = signal<string | null>(null);
  private readonly peerPresenceSignal = signal<PeerPresence>('none');
  private readonly roomViewSignal = signal<RoomView | null>(null);

  readonly roomId = computed(() => this.roomIdSignal());
  readonly role = computed(() => this.roleSignal());
  readonly playerSymbol = computed(() => this.playerSymbolSignal());
  readonly connectionState = computed(() => this.connectionStateSignal());
  readonly snapshot = computed(() => this.snapshotSignal());
  readonly board = computed(() => this.snapshotSignal().board);
  readonly winner = computed(() => this.snapshotSignal().winner);
  readonly currentTurn = computed(() => this.snapshotSignal().currentTurn);
  readonly winningLine = computed(() => this.snapshotSignal().winningLine);
  readonly errorMessage = computed(() => this.errorMessageSignal());
  readonly peerPresence = computed(() => this.peerPresenceSignal());
  readonly hasOpponent = computed(() => this.peerPresenceSignal() === 'connected');
  readonly shareUrl = computed(() => {
    const roomId = this.roomIdSignal();

    if (!this.browser || !roomId) {
      return '';
    }

    return `${window.location.origin}/game/${roomId}?join=1`;
  });
  readonly isMyTurn = computed(() => {
    const playerSymbol = this.playerSymbolSignal();

    return playerSymbol !== null && this.snapshotSignal().currentTurn === playerSymbol;
  });

  constructor() {
    if (!this.browser) {
      return;
    }

    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('beforeunload', this.handlePageHide);
  }

  async startRoom(roomId: string, mode: RoomStartMode = 'auto'): Promise<void> {
    if (!this.browser) {
      return;
    }

    const normalizedRoomId = this.normalizeRoomId(roomId);

    if (!normalizedRoomId) {
      this.setErrorState('Invalid room link.');
      return;
    }

    await this.leaveCurrentRoom();
    this.resetSignalsForRoom(normalizedRoomId);

    const client = this.getClient();
    if (client === null) {
      this.setErrorState(
        'Add your Convex deployment URL in `src/environments/environment.ts` to enable multiplayer.',
      );
      return;
    }

    this.connectionStateSignal.set(mode === 'guest' ? 'connecting' : 'starting');

    const participantId = this.getOrCreateParticipantId(normalizedRoomId);
    this.participantId = participantId;

    try {
      const result = await client.mutation(api.rooms.syncParticipant, {
        roomId: normalizedRoomId,
        sessionId: participantId,
        mode,
      });

      this.roleSignal.set(result.role);
      this.playerSymbolSignal.set(result.playerSymbol);
      this.connectionStateSignal.set(result.role === 'host' ? 'waiting' : 'connecting');
      this.errorMessageSignal.set(null);

      this.subscribeToRoom(client, normalizedRoomId, participantId);
      this.startPresenceClock();
      this.startHeartbeat(client, normalizedRoomId, participantId);
    } catch (error) {
      this.setErrorState(this.describeRoomError(error));
    }
  }

  destroyRoom(): void {
    void this.leaveCurrentRoom();
    this.resetSignals();
  }

  makeMove(index: number): void {
    if (!this.canPlayCell(index)) {
      return;
    }

    const client = this.client;
    const roomId = this.roomIdSignal();
    const participantId = this.participantId;

    if (client === null || !roomId || participantId === null) {
      return;
    }

    void client
      .mutation(api.rooms.makeMove, {
        roomId,
        sessionId: participantId,
        index,
      })
      .catch((error: unknown) => {
        this.errorMessageSignal.set(this.describeRoomError(error));
      });
  }

  resetGame(): void {
    const client = this.client;
    const roomId = this.roomIdSignal();
    const participantId = this.participantId;

    if (client === null || !roomId || participantId === null) {
      return;
    }

    void client
      .mutation(api.rooms.resetGame, {
        roomId,
        sessionId: participantId,
      })
      .catch((error: unknown) => {
        this.errorMessageSignal.set(this.describeRoomError(error));
      });
  }

  canPlayCell(index: number): boolean {
    const snapshot = this.snapshotSignal();
    const playerSymbol = this.playerSymbolSignal();

    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < snapshot.board.length &&
      this.connectionStateSignal() === 'connected' &&
      playerSymbol !== null &&
      snapshot.winner === null &&
      snapshot.currentTurn === playerSymbol &&
      snapshot.board[index] === null
    );
  }

  isWinningCell(index: number): boolean {
    return this.snapshotSignal().winningLine.includes(index);
  }

  private getClient(): ConvexClient | null {
    if (!this.browser || !environment.convexUrl) {
      return null;
    }

    this.client ??= new ConvexClient(environment.convexUrl);
    return this.client;
  }

  private subscribeToRoom(client: ConvexClient, roomId: string, participantId: string): void {
    this.unsubscribeFromRoom();

    this.roomSubscription = client.onUpdate(
      api.rooms.watchRoom,
      {
        roomId,
        sessionId: participantId,
      },
      (value) => {
        if (this.shuttingDown || this.roomIdSignal() !== roomId) {
          return;
        }

        if (value === null) {
          this.handleMissingRoom();
          return;
        }

        this.roomViewSignal.set(value);
        this.snapshotSignal.set(value.snapshot);
        this.roleSignal.set(value.role);
        this.playerSymbolSignal.set(value.playerSymbol);
        this.refreshPresence();
      },
    );
  }

  private startHeartbeat(client: ConvexClient, roomId: string, participantId: string): void {
    this.stopHeartbeat();

    this.heartbeatIntervalId = window.setInterval(() => {
      void client
        .mutation(api.rooms.sendHeartbeat, {
          roomId,
          sessionId: participantId,
        })
        .catch(() => {
          this.refreshPresence();
        });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      window.clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
  }

  private startPresenceClock(): void {
    this.stopPresenceClock();

    this.presenceIntervalId = window.setInterval(() => {
      this.refreshPresence();
    }, 1_000);
  }

  private stopPresenceClock(): void {
    if (this.presenceIntervalId !== null) {
      window.clearInterval(this.presenceIntervalId);
      this.presenceIntervalId = null;
    }
  }

  private refreshPresence(): void {
    const room = this.roomViewSignal();
    if (room === null) {
      return;
    }

    const role = room.role;
    const playerSymbol = room.playerSymbol;

    if (role === null || playerSymbol === null) {
      this.setErrorState('This room session is no longer assigned to a player slot.');
      return;
    }

    const now = Date.now();
    const opponentPresence =
      role === 'host'
        ? this.getPresence(room.guestOccupied, room.guestLastSeenAt, now)
        : this.getPresence(room.hostOccupied, room.hostLastSeenAt, now);

    this.peerPresenceSignal.set(opponentPresence);

    if (role === 'host') {
      if (opponentPresence === 'connected') {
        this.connectionStateSignal.set('connected');
        this.errorMessageSignal.set(null);
        return;
      }

      this.connectionStateSignal.set('waiting');
      this.errorMessageSignal.set(
        opponentPresence === 'disconnected'
          ? 'Your opponent disconnected. Keep this room open and share the same link to reconnect.'
          : null,
      );
      return;
    }

    if (opponentPresence === 'connected') {
      this.connectionStateSignal.set('connected');
      this.errorMessageSignal.set(null);
      return;
    }

    this.connectionStateSignal.set('disconnected');
    this.errorMessageSignal.set(
      'The room host disconnected. Ask them to reopen the room and share the same link again.',
    );
  }

  private getPresence(
    occupied: boolean,
    lastSeenAt: number | null,
    now: number,
  ): PeerPresence {
    if (!occupied) {
      return 'none';
    }

    if (lastSeenAt !== null && now - lastSeenAt < this.heartbeatTimeoutMs) {
      return 'connected';
    }

    return 'disconnected';
  }

  private handleMissingRoom(): void {
    this.roomViewSignal.set(null);
    this.peerPresenceSignal.set('disconnected');
    this.connectionStateSignal.set('disconnected');
    this.errorMessageSignal.set('The room is no longer available.');
  }

  private async leaveCurrentRoom(): Promise<void> {
    const client = this.client;
    const roomId = this.roomIdSignal();
    const participantId = this.participantId;

    this.shuttingDown = true;
    this.stopHeartbeat();
    this.stopPresenceClock();
    this.unsubscribeFromRoom();
    this.roomViewSignal.set(null);

    try {
      if (client !== null && roomId && participantId !== null) {
        await client.mutation(api.rooms.leaveRoom, {
          roomId,
          sessionId: participantId,
        });
      }
    } catch {
      // Heartbeat expiry is enough to clean up when a tab closes mid-request.
    } finally {
      this.participantId = null;
      this.shuttingDown = false;
    }
  }

  private unsubscribeFromRoom(): void {
    if (this.roomSubscription === null) {
      return;
    }

    this.roomSubscription.unsubscribe();
    this.roomSubscription = null;
  }

  private resetSignalsForRoom(roomId: string): void {
    this.roomIdSignal.set(roomId);
    this.roleSignal.set(null);
    this.playerSymbolSignal.set(null);
    this.connectionStateSignal.set('starting');
    this.snapshotSignal.set(createInitialSnapshot());
    this.errorMessageSignal.set(null);
    this.peerPresenceSignal.set('none');
    this.roomViewSignal.set(null);
  }

  private resetSignals(): void {
    this.roomIdSignal.set('');
    this.roleSignal.set(null);
    this.playerSymbolSignal.set(null);
    this.connectionStateSignal.set('idle');
    this.snapshotSignal.set(createInitialSnapshot());
    this.errorMessageSignal.set(null);
    this.peerPresenceSignal.set('none');
    this.roomViewSignal.set(null);
  }

  private getOrCreateParticipantId(roomId: string): string {
    const key = `${this.storagePrefix}${roomId}`;
    const existing = window.localStorage.getItem(key);

    if (existing) {
      return existing;
    }

    const nextValue =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);

    window.localStorage.setItem(key, nextValue);
    return nextValue;
  }

  private normalizeRoomId(value: string): string {
    return value.trim().toLowerCase();
  }

  private describeRoomError(error: unknown): string {
    if (this.hasMessage(error)) {
      return error.message;
    }

    return 'Could not reach the Convex room service. Check your connection and try again.';
  }

  private setErrorState(message: string): void {
    this.connectionStateSignal.set('error');
    this.errorMessageSignal.set(message);
  }

  private hasMessage(error: unknown): error is { message: string } {
    return typeof error === 'object' && error !== null && 'message' in error;
  }

  private isSnapshot(value: unknown): value is GameSnapshot {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const snapshot = value as Record<string, unknown>;

    return (
      Array.isArray(snapshot['board']) &&
      snapshot['board'].every((cell) => this.isCellValue(cell)) &&
      (snapshot['currentTurn'] === 'X' || snapshot['currentTurn'] === 'O') &&
      (snapshot['winner'] === 'X' ||
        snapshot['winner'] === 'O' ||
        snapshot['winner'] === 'draw' ||
        snapshot['winner'] === null) &&
      Array.isArray(snapshot['winningLine']) &&
      snapshot['winningLine'].every((index) => typeof index === 'number')
    );
  }

  private isCellValue(value: unknown): value is CellValue {
    return value === 'X' || value === 'O' || value === null;
  }

  private readonly handlePageHide = (): void => {
    if (!this.browser || !this.roomIdSignal()) {
      return;
    }

    void this.leaveCurrentRoom();
  };
}
