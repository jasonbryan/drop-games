import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import {
  applyMove,
  createInitialSnapshot,
  type GameSnapshot,
  type PlayerSymbol,
} from '../game/tic-tac-toe';

type PeerInstance = import('peerjs').Peer;
type DataConnection = import('peerjs').DataConnection;

type PeerRole = 'host' | 'guest' | null;
type RoomStartMode = 'auto' | 'guest';
type ConnectionState =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

interface MoveMessage {
  type: 'move';
  index: number;
}

interface ResetMessage {
  type: 'reset';
}

interface PingMessage {
  type: 'ping';
}

interface PongMessage {
  type: 'pong';
}

interface GoodbyeMessage {
  type: 'goodbye';
}

interface SnapshotMessage {
  type: 'snapshot';
  snapshot: GameSnapshot;
}

interface RoomFullMessage {
  type: 'room-full';
  message: string;
}

type GuestMessage = MoveMessage | ResetMessage;
type ControlMessage = PingMessage | PongMessage | GoodbyeMessage;
type GuestMessageWithControl = GuestMessage | ControlMessage;
type HostMessage = SnapshotMessage | RoomFullMessage;
type HostMessageWithControl = HostMessage | ControlMessage;
type PeerPresence = 'none' | 'connected' | 'disconnected';

@Injectable({ providedIn: 'root' })
export class PeerGameService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly browser = isPlatformBrowser(this.platformId);
  private readonly startupTimeoutMs = 10_000;
  private readonly heartbeatIntervalMs = 4_000;
  private readonly heartbeatTimeoutMs = 12_000;

  private peer: PeerInstance | null = null;
  private connection: DataConnection | null = null;
  private shuttingDown = false;
  private heartbeatIntervalId: number | null = null;
  private heartbeatTimeoutId: number | null = null;

  private readonly roomIdSignal = signal('');
  private readonly roleSignal = signal<PeerRole>(null);
  private readonly playerSymbolSignal = signal<PlayerSymbol | null>(null);
  private readonly connectionStateSignal = signal<ConnectionState>('idle');
  private readonly snapshotSignal = signal<GameSnapshot>(createInitialSnapshot());
  private readonly errorMessageSignal = signal<string | null>(null);
  private readonly remotePeerIdSignal = signal<string | null>(null);
  private readonly peerPresenceSignal = signal<PeerPresence>('none');

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
  readonly remotePeerId = computed(() => this.remotePeerIdSignal());
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

    const normalizedRoomId = roomId.trim().toLowerCase();

    if (!normalizedRoomId) {
      this.setErrorState('Invalid room link.');
      return;
    }

    this.resetSignalsForRoom(normalizedRoomId);
    this.destroyTransport();

    try {
      if (mode === 'guest') {
        await this.becomeGuest(normalizedRoomId);
        return;
      }

      await this.becomeHost(normalizedRoomId);
    } catch (error) {
      if (this.isUnavailableIdError(error)) {
        await this.becomeGuest(normalizedRoomId);
        return;
      }

      this.setErrorState(this.describePeerError(error));
    }
  }

  destroyRoom(): void {
    this.destroyTransport();
    this.resetSignals();
  }

  makeMove(index: number): void {
    if (!this.canPlayCell(index)) {
      return;
    }

    if (this.roleSignal() === 'host') {
      this.applyHostMove(index, 'X');
      return;
    }

    this.connection?.send({ type: 'move', index } satisfies MoveMessage);
  }

  resetGame(): void {
    if (this.roleSignal() === 'host') {
      this.snapshotSignal.set(createInitialSnapshot());
      this.sendSnapshot();
      return;
    }

    this.connection?.send({ type: 'reset' } satisfies ResetMessage);
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

  private async becomeHost(roomId: string): Promise<void> {
    const peer = await this.createPeer(roomId);
    this.peer = peer;
    this.roleSignal.set('host');
    this.playerSymbolSignal.set('X');
    this.connectionStateSignal.set('waiting');

    this.registerPeerLifecycle(peer);

    peer.on('connection', (connection) => {
      if (this.connection !== null && this.connection.open) {
        this.rejectExtraConnection(connection);
        return;
      }

      this.attachHostConnection(connection);
    });
  }

  private async becomeGuest(roomId: string): Promise<void> {
    const peer = await this.createPeer();
    this.peer = peer;
    this.roleSignal.set('guest');
    this.playerSymbolSignal.set('O');
    this.connectionStateSignal.set('connecting');

    this.registerPeerLifecycle(peer);

    const connection = peer.connect(roomId, {
      reliable: true,
      serialization: 'json',
    });

    this.attachGuestConnection(connection);
  }

  private async createPeer(id?: string): Promise<PeerInstance> {
    const peerModule = await import('peerjs');
    const PeerCtor = (peerModule.Peer ?? peerModule.default) as typeof import('peerjs').Peer;

    return await new Promise<PeerInstance>((resolve, reject) => {
      const peer = id
        ? new PeerCtor(id, this.getPeerOptions())
        : new PeerCtor(this.getPeerOptions());

      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        peer.destroy();
        reject(new Error('Timed out while connecting to the signaling server.'));
      }, this.startupTimeoutMs);

      const handleOpen = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(peer);
      };

      const handleError = (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        peer.destroy();
        reject(error);
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        peer.off('open', handleOpen);
        peer.off('error', handleError);
      };

      peer.on('open', handleOpen);
      peer.on('error', handleError);

      if (peer.open) {
        handleOpen();
      }
    });
  }

  private getPeerOptions(): import('peerjs').PeerJSOption {
    const { hostname, port, protocol } = window.location;

    if (
      protocol === 'http:' &&
      port === '4200' &&
      (hostname === 'localhost' || hostname === '127.0.0.1')
    ) {
      return {
        host: hostname,
        port: 9000,
        secure: false,
        path: '/drop-games',
      };
    }

    return {
      key: 'drop-games',
      host: hostname,
      port: port ? Number(port) : protocol === 'https:' ? 443 : 80,
      secure: protocol === 'https:',
      path: '/peerjs',
    };
  }

  private registerPeerLifecycle(peer: PeerInstance): void {
    peer.on('error', (error) => {
      if (this.shuttingDown) {
        return;
      }

      this.setErrorState(this.describePeerError(error));
    });

    peer.on('close', () => {
      if (this.shuttingDown) {
        return;
      }

      this.handleDisconnect('Peer session closed.');
    });

    peer.on('disconnected', () => {
      if (this.shuttingDown) {
        return;
      }

      this.handleDisconnect('Connection to the signaling server was lost. Trying again may restore the room.');
    });
  }

  private attachHostConnection(connection: DataConnection): void {
    this.connection = connection;

    connection.on('open', () => {
      if (this.shuttingDown) {
        return;
      }

      this.remotePeerIdSignal.set(connection.peer);
      this.peerPresenceSignal.set('connected');
      this.connectionStateSignal.set('connected');
      this.errorMessageSignal.set(null);
      this.markPeerActivity();
      this.startHeartbeat();
      this.sendSnapshot();
    });

    connection.on('data', (message) => {
      if (this.shuttingDown) {
        return;
      }

      this.markPeerActivity();
      this.handleGuestMessage(message);
    });

    connection.on('close', () => {
      if (this.shuttingDown) {
        return;
      }

      this.handleRemoteDisconnect('Your opponent disconnected. Keep this room open and share the same link to reconnect.');
    });

    connection.on('error', () => {
      if (this.shuttingDown) {
        return;
      }

      this.handleRemoteDisconnect('The player connection ended unexpectedly.');
    });
  }

  private attachGuestConnection(connection: DataConnection): void {
    this.connection = connection;

    connection.on('open', () => {
      if (this.shuttingDown) {
        return;
      }

      this.remotePeerIdSignal.set(connection.peer);
      this.peerPresenceSignal.set('connected');
      this.connectionStateSignal.set('connected');
      this.errorMessageSignal.set(null);
      this.markPeerActivity();
      this.startHeartbeat();
    });

    connection.on('data', (message) => {
      if (this.shuttingDown) {
        return;
      }

      this.markPeerActivity();
      this.handleHostMessage(message);
    });

    connection.on('close', () => {
      if (this.shuttingDown) {
        return;
      }

      this.handleRemoteDisconnect('The room host disconnected. Ask them to reopen the room and share the same link again.');
    });

    connection.on('error', () => {
      if (this.shuttingDown) {
        return;
      }

      this.handleRemoteDisconnect('The player connection ended unexpectedly.');
    });
  }

  private handleGuestMessage(message: unknown): void {
    if (this.isControlMessage(message)) {
      this.handleControlMessage(message);
      return;
    }

    if (!this.isGuestMessage(message)) {
      return;
    }

    if (message.type === 'move') {
      this.applyHostMove(message.index, 'O');
      return;
    }

    this.snapshotSignal.set(createInitialSnapshot());
    this.sendSnapshot();
  }

  private handleHostMessage(message: unknown): void {
    if (this.isControlMessage(message)) {
      this.handleControlMessage(message);
      return;
    }

    if (!this.isHostMessage(message)) {
      return;
    }

    if (message.type === 'snapshot') {
      this.snapshotSignal.set(message.snapshot);
      return;
    }

    this.setErrorState(message.message);
  }

  private applyHostMove(index: number, player: PlayerSymbol): void {
    const snapshot = this.snapshotSignal();
    const nextSnapshot = applyMove(snapshot, index, player);

    if (nextSnapshot === snapshot) {
      return;
    }

    this.snapshotSignal.set(nextSnapshot);
    this.sendSnapshot();
  }

  private sendSnapshot(): void {
    if (!this.connection?.open) {
      return;
    }

    this.connection.send({
      type: 'snapshot',
      snapshot: this.snapshotSignal(),
    } satisfies SnapshotMessage);
  }

  private rejectExtraConnection(connection: DataConnection): void {
    connection.on('open', () => {
      connection.send({
        type: 'room-full',
        message: 'This room already has two players.',
      } satisfies RoomFullMessage);

      connection.close();
    });
  }

  private handleControlMessage(message: ControlMessage): void {
    if (message.type === 'ping') {
      this.sendControlMessage({ type: 'pong' });
      return;
    }

    if (message.type === 'goodbye') {
      if (this.roleSignal() === 'host') {
        this.handleRemoteDisconnect('Your opponent left the room.');
        return;
      }

      this.handleRemoteDisconnect('The room host left the room.');
    }
  }

  private sendControlMessage(message: ControlMessage): void {
    if (!this.connection?.open) {
      return;
    }

    this.connection.send(message);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.markPeerActivity();

    this.heartbeatIntervalId = window.setInterval(() => {
      this.sendControlMessage({ type: 'ping' });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      window.clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }

    if (this.heartbeatTimeoutId !== null) {
      window.clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private markPeerActivity(): void {
    if (this.heartbeatTimeoutId !== null) {
      window.clearTimeout(this.heartbeatTimeoutId);
    }

    this.heartbeatTimeoutId = window.setTimeout(() => {
      this.handleRemoteDisconnect(
        this.roleSignal() === 'host'
          ? 'Your opponent stopped responding. They may have closed the tab.'
          : 'The room host stopped responding. They may have closed the tab.',
      );
    }, this.heartbeatTimeoutMs);
  }

  private handleRemoteDisconnect(message: string): void {
    this.stopHeartbeat();
    this.connection = null;
    this.remotePeerIdSignal.set(null);
    this.peerPresenceSignal.set('disconnected');

    if (this.roleSignal() === 'host') {
      this.connectionStateSignal.set('waiting');
      this.errorMessageSignal.set(message);
      return;
    }

    this.connectionStateSignal.set('disconnected');
    this.errorMessageSignal.set(message);
  }

  private handleDisconnect(message: string): void {
    this.stopHeartbeat();
    this.connection = null;
    this.remotePeerIdSignal.set(null);
    this.peerPresenceSignal.set('disconnected');

    if (this.roleSignal() === 'host') {
      this.connectionStateSignal.set('waiting');
      this.errorMessageSignal.set(message);
      return;
    }

    this.connectionStateSignal.set('disconnected');
    this.errorMessageSignal.set(message);
  }

  private resetSignalsForRoom(roomId: string): void {
    this.roomIdSignal.set(roomId);
    this.roleSignal.set(null);
    this.playerSymbolSignal.set(null);
    this.connectionStateSignal.set('starting');
    this.snapshotSignal.set(createInitialSnapshot());
    this.errorMessageSignal.set(null);
    this.remotePeerIdSignal.set(null);
    this.peerPresenceSignal.set('none');
  }

  private resetSignals(): void {
    this.roomIdSignal.set('');
    this.roleSignal.set(null);
    this.playerSymbolSignal.set(null);
    this.connectionStateSignal.set('idle');
    this.snapshotSignal.set(createInitialSnapshot());
    this.errorMessageSignal.set(null);
    this.remotePeerIdSignal.set(null);
    this.peerPresenceSignal.set('none');
  }

  private destroyTransport(): void {
    this.shuttingDown = true;
    this.stopHeartbeat();

    try {
      this.sendControlMessage({ type: 'goodbye' });
      this.connection?.close();
      this.peer?.destroy();
    } finally {
      this.connection = null;
      this.peer = null;
      this.shuttingDown = false;
    }
  }

  private setErrorState(message: string): void {
    this.connectionStateSignal.set('error');
    this.errorMessageSignal.set(message);
  }

  private isUnavailableIdError(error: unknown): boolean {
    return this.getErrorType(error) === 'unavailable-id';
  }

  private describePeerError(error: unknown): string {
    const type = this.getErrorType(error);

    if (type === 'peer-unavailable') {
      return 'The room host is offline. Ask them to open the room link again.';
    }

    if (type === 'network') {
      if (this.isLocalDevPeerMode()) {
        return 'Unable to reach the local PeerJS server. Run `bun start` and try again.';
      }

      return 'Unable to reach the signaling server. Check your connection and try again.';
    }

    if (type === 'browser-incompatible') {
      return 'Your browser does not support the required peer-to-peer features.';
    }

    if (this.hasMessage(error)) {
      if (
        this.isLocalDevPeerMode() &&
        error.message.toLowerCase().includes('timed out while connecting to the signaling server')
      ) {
        return 'The local PeerJS server did not respond. Run `bun start` and reload the room.';
      }

      return error.message;
    }

    return 'Something went wrong while setting up the peer connection.';
  }

  private getErrorType(error: unknown): string | null {
    if (!this.isRecord(error)) {
      return null;
    }

    return typeof error['type'] === 'string' ? error['type'] : null;
  }

  private hasMessage(error: unknown): error is { message: string } {
    return this.isRecord(error) && typeof error['message'] === 'string';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isLocalDevPeerMode(): boolean {
    if (!this.browser) {
      return false;
    }

    const { hostname, port, protocol } = window.location;

    return (
      protocol === 'http:' &&
      port === '4200' &&
      (hostname === 'localhost' || hostname === '127.0.0.1')
    );
  }

  private isGuestMessage(message: unknown): message is GuestMessage {
    if (!this.isRecord(message) || typeof message['type'] !== 'string') {
      return false;
    }

    if (message['type'] === 'reset') {
      return true;
    }

    return message['type'] === 'move' && typeof message['index'] === 'number';
  }

  private isControlMessage(message: unknown): message is ControlMessage {
    if (!this.isRecord(message) || typeof message['type'] !== 'string') {
      return false;
    }

    return (
      message['type'] === 'ping' ||
      message['type'] === 'pong' ||
      message['type'] === 'goodbye'
    );
  }

  private isHostMessage(message: unknown): message is HostMessage {
    if (!this.isRecord(message) || typeof message['type'] !== 'string') {
      return false;
    }

    if (message['type'] === 'room-full') {
      return typeof message['message'] === 'string';
    }

    return message['type'] === 'snapshot' && this.isSnapshot(message['snapshot']);
  }

  private isSnapshot(snapshot: unknown): snapshot is GameSnapshot {
    if (!this.isRecord(snapshot)) {
      return false;
    }

    return (
      Array.isArray(snapshot['board']) &&
      typeof snapshot['currentTurn'] === 'string' &&
      Array.isArray(snapshot['winningLine']) &&
      (snapshot['winner'] === null ||
        snapshot['winner'] === 'X' ||
        snapshot['winner'] === 'O' ||
        snapshot['winner'] === 'draw')
    );
  }

  private readonly handlePageHide = (): void => {
    if (!this.browser || this.peer === null) {
      return;
    }

    this.destroyTransport();
  };
}
