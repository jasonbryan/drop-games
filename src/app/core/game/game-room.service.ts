import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ConvexClient } from 'convex/browser';

import { createInitialSnapshot, type GameSnapshot, type PlayerSymbol } from './tic-tac-toe';
import { environment } from '../../../environments/environment';
import { api } from '../../../../convex/_generated/api';
import { type GameSlug } from '../../games/catalog';

type PlayerRole = 'host' | 'guest' | null;
type RoomStartMode = 'auto' | 'guest';
type ConnectionState = 'idle' | 'starting' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';
type PeerPresence = 'none' | 'connected' | 'disconnected';

interface YahtzeeState {
  currentTurn: 'host' | 'guest';
  rollNumber: number;
  dice: number[];
  heldDice: boolean[];
  scorecardHost: Record<string, number | null>;
  scorecardGuest: Record<string, number | null>;
  upperBonusHost: number;
  upperBonusGuest: number;
  yahtzeeBonusHost: number;
  yahtzeeBonusGuest: number;
  winner: 'host' | 'guest' | 'draw' | null;
}

interface RoomView {
  roomId: string;
  gameSlug: GameSlug;
  role: PlayerRole;
  playerSymbol: PlayerSymbol | null;
  hostOccupied: boolean;
  guestOccupied: boolean;
  hostLastSeenAt: number | null;
  guestLastSeenAt: number | null;
  ticTacToeSnapshot: GameSnapshot | null;
  yahtzeeState: YahtzeeState | null;
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
  private readonly gameSlugSignal = signal<GameSlug>('tic-tac-toe');
  private readonly roleSignal = signal<PlayerRole>(null);
  private readonly playerSymbolSignal = signal<PlayerSymbol | null>(null);
  private readonly connectionStateSignal = signal<ConnectionState>('idle');
  private readonly snapshotSignal = signal<GameSnapshot>(createInitialSnapshot());
  private readonly yahtzeeStateSignal = signal<YahtzeeState | null>(null);
  private readonly errorMessageSignal = signal<string | null>(null);
  private readonly peerPresenceSignal = signal<PeerPresence>('none');
  private readonly roomViewSignal = signal<RoomView | null>(null);

  readonly roomId = computed(() => this.roomIdSignal());
  readonly gameSlug = computed(() => this.gameSlugSignal());
  readonly role = computed(() => this.roleSignal());
  readonly playerSymbol = computed(() => this.playerSymbolSignal());
  readonly connectionState = computed(() => this.connectionStateSignal());
  readonly snapshot = computed(() => this.snapshotSignal());
  readonly yahtzeeState = computed(() => this.yahtzeeStateSignal());
  readonly board = computed(() => this.snapshotSignal().board);
  readonly winner = computed(() => {
    if (this.gameSlugSignal() === 'tic-tac-toe') return this.snapshotSignal().winner;
    const winner = this.yahtzeeStateSignal()?.winner ?? null;
    return winner === 'host' ? 'X' : winner === 'guest' ? 'O' : winner;
  });
  readonly currentTurn = computed(() => {
    if (this.gameSlugSignal() === 'tic-tac-toe') return this.snapshotSignal().currentTurn;
    return this.yahtzeeStateSignal()?.currentTurn === 'guest' ? 'O' : 'X';
  });
  readonly winningLine = computed(() => this.snapshotSignal().winningLine);
  readonly errorMessage = computed(() => this.errorMessageSignal());
  readonly peerPresence = computed(() => this.peerPresenceSignal());
  readonly shareUrl = computed(() =>
    !this.browser || !this.roomIdSignal()
      ? ''
      : `${window.location.origin}/play/${this.gameSlugSignal()}/${this.roomIdSignal()}?join=1`,
  );
  readonly isMyTurn = computed(() => {
    if (this.gameSlugSignal() === 'yahtzee') {
      const role = this.roleSignal();
      return role !== null && this.yahtzeeStateSignal()?.currentTurn === role;
    }
    const symbol = this.playerSymbolSignal();
    return symbol !== null && this.snapshotSignal().currentTurn === symbol;
  });

  constructor() {
    if (!this.browser) return;
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('beforeunload', this.handlePageHide);
  }

  async startRoom(gameSlug: GameSlug, roomId: string, mode: RoomStartMode = 'auto'): Promise<void> {
    if (!this.browser) return;
    const normalizedRoomId = roomId.trim().toLowerCase();
    if (!normalizedRoomId) return this.setErrorState('Invalid room link.');
    await this.leaveCurrentRoom();
    this.resetSignalsForRoom(gameSlug, normalizedRoomId);
    const client = this.getClient();
    if (!client) return this.setErrorState('Add your Convex deployment URL in environment.ts.');
    this.connectionStateSignal.set(mode === 'guest' ? 'connecting' : 'starting');
    const participantId = this.getOrCreateParticipantId(normalizedRoomId);
    this.participantId = participantId;

    try {
      const result = await client.mutation(api.rooms.syncParticipant, {
        roomId: normalizedRoomId,
        sessionId: participantId,
        mode,
        gameSlug,
      });
      this.gameSlugSignal.set(result.gameSlug);
      this.roleSignal.set(result.role);
      this.playerSymbolSignal.set(result.playerSymbol);
      this.connectionStateSignal.set(result.role === 'host' ? 'waiting' : result.role === 'guest' ? 'connecting' : 'connected');
      this.errorMessageSignal.set(null);
      this.subscribeToRoom(client, normalizedRoomId, participantId);
      this.startPresenceClock();
      result.role ? this.startHeartbeat(client, normalizedRoomId, participantId) : this.stopHeartbeat();
    } catch (error) {
      this.setErrorState(this.describeRoomError(error));
    }
  }

  destroyRoom(): void {
    void this.leaveCurrentRoom();
    this.resetSignals();
  }

  makeMove(index: number): void {
    if (this.gameSlugSignal() !== 'tic-tac-toe' || !this.canPlayCell(index)) return;
    if (!this.client || !this.roomIdSignal() || !this.participantId) return;
    void this.client
      .mutation(api.rooms.makeMove, { roomId: this.roomIdSignal(), sessionId: this.participantId, index })
      .catch(() => {});
  }

  resetGame(): void {
    if (!this.client || !this.roomIdSignal() || !this.participantId) return;
    void this.client
      .mutation(api.rooms.resetGame, { roomId: this.roomIdSignal(), sessionId: this.participantId })
      .catch(() => {});
  }

  rollYahtzee(): void {
    if (this.gameSlugSignal() !== 'yahtzee' || !this.client || !this.roomIdSignal() || !this.participantId) return;
    void this.client
      .mutation(api.rooms.rollYahtzee, { roomId: this.roomIdSignal(), sessionId: this.participantId })
      .catch(() => {});
  }

  toggleYahtzeeHold(dieIndex: number): void {
    if (this.gameSlugSignal() !== 'yahtzee' || !this.client || !this.roomIdSignal() || !this.participantId) return;
    void this.client
      .mutation(api.rooms.toggleYahtzeeHold, {
        roomId: this.roomIdSignal(),
        sessionId: this.participantId,
        dieIndex,
      })
      .catch(() => {});
  }

  scoreYahtzee(category: string): void {
    if (this.gameSlugSignal() !== 'yahtzee' || !this.client || !this.roomIdSignal() || !this.participantId) return;
    void this.client
      .mutation(api.rooms.scoreYahtzee, {
        roomId: this.roomIdSignal(),
        sessionId: this.participantId,
        category,
      })
      .catch(() => {});
  }

  canPlayCell(index: number): boolean {
    if (this.gameSlugSignal() !== 'tic-tac-toe') return false;
    const snapshot = this.snapshotSignal();
    const symbol = this.playerSymbolSignal();
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < snapshot.board.length &&
      this.connectionStateSignal() === 'connected' &&
      symbol !== null &&
      snapshot.winner === null &&
      snapshot.currentTurn === symbol &&
      snapshot.board[index] === null
    );
  }

  isWinningCell(index: number): boolean {
    return this.snapshotSignal().winningLine.includes(index);
  }

  private getClient(): ConvexClient | null {
    if (!this.browser || !environment.convexUrl) return null;
    this.client ??= new ConvexClient(environment.convexUrl);
    return this.client;
  }

  private subscribeToRoom(client: ConvexClient, roomId: string, participantId: string): void {
    this.unsubscribeFromRoom();
    this.roomSubscription = client.onUpdate(api.rooms.watchRoom, { roomId, sessionId: participantId }, (value) => {
      if (this.shuttingDown || this.roomIdSignal() !== roomId) return;
      if (value === null) return this.handleMissingRoom();
      const room = value as unknown as RoomView;
      this.roomViewSignal.set(room);
      this.gameSlugSignal.set(room.gameSlug);
      this.snapshotSignal.set(room.ticTacToeSnapshot ?? createInitialSnapshot());
      this.yahtzeeStateSignal.set(room.yahtzeeState);
      this.roleSignal.set(room.role);
      this.playerSymbolSignal.set(room.playerSymbol);
      this.refreshPresence();
    });
  }

  private startHeartbeat(client: ConvexClient, roomId: string, participantId: string): void {
    this.stopHeartbeat();
    this.heartbeatIntervalId = window.setInterval(() => {
      void client.mutation(api.rooms.sendHeartbeat, { roomId, sessionId: participantId }).catch(() => this.refreshPresence());
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) window.clearInterval(this.heartbeatIntervalId);
    this.heartbeatIntervalId = null;
  }

  private startPresenceClock(): void {
    this.stopPresenceClock();
    this.presenceIntervalId = window.setInterval(() => this.refreshPresence(), 1_000);
  }

  private stopPresenceClock(): void {
    if (this.presenceIntervalId !== null) window.clearInterval(this.presenceIntervalId);
    this.presenceIntervalId = null;
  }

  private refreshPresence(): void {
    const room = this.roomViewSignal();
    if (!room) return;
    const now = Date.now();
    const hostPresence = this.getPresence(room.hostOccupied, room.hostLastSeenAt, now);
    const guestPresence = this.getPresence(room.guestOccupied, room.guestLastSeenAt, now);
    const role = room.role;
    if (!role) {
      this.peerPresenceSignal.set(hostPresence === 'connected' || guestPresence === 'connected' ? 'connected' : 'disconnected');
      this.connectionStateSignal.set('connected');
      this.errorMessageSignal.set(null);
      return;
    }
    const opponentPresence = role === 'host' ? guestPresence : hostPresence;
    this.peerPresenceSignal.set(opponentPresence);
    if (role === 'host' && opponentPresence !== 'connected') {
      this.connectionStateSignal.set('waiting');
      return;
    }
    if (role === 'guest' && opponentPresence !== 'connected') {
      this.connectionStateSignal.set('disconnected');
      return;
    }
    this.connectionStateSignal.set('connected');
    this.errorMessageSignal.set(null);
  }

  private getPresence(occupied: boolean, lastSeenAt: number | null, now: number): PeerPresence {
    if (!occupied) return 'none';
    return lastSeenAt !== null && now - lastSeenAt < this.heartbeatTimeoutMs ? 'connected' : 'disconnected';
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
      if (client && roomId && participantId) {
        await client.mutation(api.rooms.leaveRoom, { roomId, sessionId: participantId });
      }
    } catch {
      // noop
    } finally {
      this.participantId = null;
      this.shuttingDown = false;
    }
  }

  private unsubscribeFromRoom(): void {
    if (this.roomSubscription) this.roomSubscription.unsubscribe();
    this.roomSubscription = null;
  }

  private resetSignalsForRoom(gameSlug: GameSlug, roomId: string): void {
    this.gameSlugSignal.set(gameSlug);
    this.roomIdSignal.set(roomId);
    this.roleSignal.set(null);
    this.playerSymbolSignal.set(null);
    this.connectionStateSignal.set('starting');
    this.snapshotSignal.set(createInitialSnapshot());
    this.yahtzeeStateSignal.set(null);
    this.errorMessageSignal.set(null);
    this.peerPresenceSignal.set('none');
    this.roomViewSignal.set(null);
  }

  private resetSignals(): void {
    this.roomIdSignal.set('');
    this.gameSlugSignal.set('tic-tac-toe');
    this.roleSignal.set(null);
    this.playerSymbolSignal.set(null);
    this.connectionStateSignal.set('idle');
    this.snapshotSignal.set(createInitialSnapshot());
    this.yahtzeeStateSignal.set(null);
    this.errorMessageSignal.set(null);
    this.peerPresenceSignal.set('none');
    this.roomViewSignal.set(null);
  }

  private getOrCreateParticipantId(roomId: string): string {
    const key = `${this.storagePrefix}${roomId}`;
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const next =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);
    window.localStorage.setItem(key, next);
    return next;
  }

  private describeRoomError(error: unknown): string {
    return typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: string }).message)
      : 'Could not reach the room service.';
  }

  private setErrorState(message: string): void {
    this.connectionStateSignal.set('error');
    this.errorMessageSignal.set(message);
  }

  private readonly handlePageHide = (): void => {
    if (!this.browser || !this.roomIdSignal()) return;
    void this.leaveCurrentRoom();
  };
}
