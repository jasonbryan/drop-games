import { CommonModule } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { GameRoomService } from '../../core/game/game-room.service';

@Component({
  selector: 'app-game-page',
  imports: [CommonModule, RouterLink],
  templateUrl: './game-page.html',
  styleUrl: './game-page.css',
})
export class GamePageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private copyToastTimeoutId: number | null = null;

  protected readonly game = inject(GameRoomService);
  protected readonly cells = Array.from({ length: 9 }, (_, index) => index);
  protected readonly copyState = signal<'idle' | 'copied' | 'error'>('idle');
  protected readonly qrCodeDataUrl = signal('');

  protected readonly statusMessage = computed(() => {
    const connectionState = this.game.connectionState();
    const winner = this.game.winner();
    const errorMessage = this.game.errorMessage();

    if (winner === 'draw') {
      return 'Draw game. Hit play again for another round.';
    }

    if (winner === 'X' || winner === 'O') {
      return this.game.playerSymbol() === winner ? 'You won the round.' : 'Your opponent won the round.';
    }

    if (errorMessage && (connectionState === 'error' || connectionState === 'disconnected')) {
      return errorMessage;
    }

    if (connectionState === 'starting') {
      return 'Setting up the room...';
    }

    if (connectionState === 'waiting') {
      return 'Room ready. Share the link and wait for your second player.';
    }

    if (connectionState === 'connecting') {
      return 'Joining the room host...';
    }

    if (connectionState === 'connected') {
      return this.game.isMyTurn() ? 'Your turn.' : 'Opponent turn.';
    }

    return 'Preparing the game board...';
  });

  protected readonly statusDetail = computed(() => {
    const connectionState = this.game.connectionState();
    const winner = this.game.winner();
    const errorMessage = this.game.errorMessage();
    const role = this.game.role();
    const peerPresence = this.game.peerPresence();

    if (winner !== null) {
      return winner === 'draw'
        ? 'Nobody wins this round.'
        : this.game.playerSymbol() === winner
          ? 'You closed the winning line first.'
          : 'They completed the winning line first.';
    }

    if (connectionState === 'starting') {
      return 'Claiming the room and syncing the initial Convex state.';
    }

    if (connectionState === 'waiting') {
      return peerPresence === 'disconnected'
        ? 'Your room is still open, but the other player left.'
        : 'You are the host. The game starts as soon as another player joins.';
    }

    if (connectionState === 'connecting') {
      return 'You are joining as O. This can take a second while the shared room state connects.';
    }

    if (connectionState === 'connected') {
      return this.game.isMyTurn()
        ? 'Pick any open square to make your move.'
        : 'Watch for their move. The board updates automatically.';
    }

    if (connectionState === 'disconnected' || connectionState === 'error') {
      return errorMessage ?? 'The connection ended unexpectedly.';
    }

    if (!role) {
      return 'Loading room details.';
    }

    return 'Room information is updating.';
  });

  protected readonly detailMessage = computed(() => {
    const role = this.game.role();
    const symbol = this.game.playerSymbol();
    const currentTurn = this.game.currentTurn();

    if (!role || !symbol) {
      return 'Room is loading.';
    }

    return `${this.capitalize(role)} player • You are ${symbol} • ${currentTurn} moves next`;
  });

  protected readonly roleChipLabel = computed(() => {
    const role = this.game.role();
    const connectionState = this.game.connectionState();
    const peerPresence = this.game.peerPresence();

    if (!role) {
      return 'Assigning player';
    }

    if (role === 'host') {
      if (connectionState === 'connected') {
        return 'Guest connected';
      }

      if (connectionState === 'waiting') {
        return peerPresence === 'disconnected' ? 'Guest disconnected' : 'Waiting for guest';
      }

      if (connectionState === 'error') {
        return 'Host error';
      }

      return 'Host online';
    }

    if (connectionState === 'connected') {
      return 'Host connected';
    }

    if (connectionState === 'disconnected') {
      return 'Host disconnected';
    }

    if (connectionState === 'error') {
      return 'Guest error';
    }

    if (connectionState === 'connecting' || connectionState === 'starting') {
      return 'Guest joining';
    }

    return 'Guest ready';
  });

  protected readonly roleChipClasses = computed(() => {
    const role = this.game.role();
    const connectionState = this.game.connectionState();
    const winner = this.game.winner();
    const peerPresence = this.game.peerPresence();

    if (connectionState === 'connected' && this.game.isMyTurn() && winner === null) {
      return 'border-violet-400/30 bg-violet-400/12 text-violet-100 shadow-[0_0_0_1px_rgba(167,139,250,0.15)] motion-safe:animate-pulse';
    }

    if (winner === this.game.playerSymbol() && winner !== null) {
      return 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100';
    }

    if (role === 'host' && connectionState === 'waiting' && peerPresence === 'disconnected') {
      return 'border-rose-400/30 bg-rose-400/10 text-rose-100';
    }

    if (role === 'host' && connectionState === 'waiting') {
      return 'border-amber-400/30 bg-amber-400/10 text-amber-100';
    }

    if (connectionState === 'disconnected' || connectionState === 'error') {
      return 'border-rose-400/30 bg-rose-400/10 text-rose-100';
    }

    if (connectionState === 'connected') {
      return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100';
    }

    return 'border-white/10 bg-white/5 text-zinc-300';
  });

  protected readonly toastMessage = computed(() => {
    switch (this.copyState()) {
      case 'copied':
        return 'Invite link copied';
      case 'error':
        return 'Could not copy the invite link';
      default:
        return '';
    }
  });

  protected readonly toastClasses = computed(() => {
    switch (this.copyState()) {
      case 'copied':
        return 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100';
      case 'error':
        return 'border-rose-400/30 bg-rose-400/12 text-rose-100';
      default:
        return 'border-white/10 bg-white/5 text-zinc-200';
    }
  });

  constructor() {
    effect(() => {
      const shareUrl = this.game.shareUrl();

      if (!shareUrl) {
        this.qrCodeDataUrl.set('');
        return;
      }

      void this.generateQrCode(shareUrl);
    });

    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const roomId = params.get('roomId');
      const joinMode = this.route.snapshot.queryParamMap.get('join');

      if (!roomId) {
        void this.router.navigateByUrl('/');
        return;
      }

      void this.game.startRoom(roomId, joinMode === '1' ? 'guest' : 'auto');
    });

    this.destroyRef.onDestroy(() => {
      this.clearCopyToastTimeout();
      this.game.destroyRoom();
    });
  }

  protected playCell(index: number): void {
    this.game.makeMove(index);
  }

  protected resetGame(): void {
    this.game.resetGame();
  }

  protected async copyLink(): Promise<void> {
    const shareUrl = this.game.shareUrl();

    if (!shareUrl || typeof navigator === 'undefined' || !navigator.clipboard) {
      this.copyState.set('error');
      this.scheduleCopyToastReset();
      return;
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      this.copyState.set('copied');
      this.scheduleCopyToastReset();
    } catch {
      this.copyState.set('error');
      this.scheduleCopyToastReset();
    }
  }

  protected cellLabel(index: number): string {
    const value = this.game.board()[index];
    return value ?? ' ';
  }

  protected cellClasses(index: number): string {
    const value = this.game.board()[index];
    const winningCell = this.game.isWinningCell(index);
    const playable = this.game.canPlayCell(index);

    if (winningCell) {
      return 'border-emerald-400/60 bg-emerald-400/20 text-emerald-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_1px_rgba(52,211,153,0.2)] motion-safe:animate-pulse';
    }

    if (value === 'X') {
      return 'border-violet-400/40 bg-violet-400/10 text-violet-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]';
    }

    if (value === 'O') {
      return 'border-sky-400/40 bg-sky-400/10 text-sky-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]';
    }

    return playable
      ? 'border-white/10 bg-white/5 text-zinc-100 shadow-[0_10px_30px_rgba(0,0,0,0.22)] hover:border-zinc-300/40 hover:bg-white/10'
      : 'border-white/10 bg-white/3 text-zinc-500 shadow-none';
  }

  protected copyButtonLabel(): string {
    if (this.copyState() === 'copied') {
      return 'Link copied';
    }

    if (this.copyState() === 'error') {
      return 'Copy failed';
    }

    return 'Copy invite link';
  }

  protected shareLinkLabel(): string {
    return this.game.shareUrl() || 'Invite link appears once the room is ready.';
  }

  protected showToast(): boolean {
    return this.copyState() !== 'idle';
  }

  private scheduleCopyToastReset(): void {
    this.clearCopyToastTimeout();
    this.copyToastTimeoutId = window.setTimeout(() => {
      this.copyState.set('idle');
      this.copyToastTimeoutId = null;
    }, 2200);
  }

  private clearCopyToastTimeout(): void {
    if (this.copyToastTimeoutId === null) {
      return;
    }

    window.clearTimeout(this.copyToastTimeoutId);
    this.copyToastTimeoutId = null;
  }

  private async generateQrCode(shareUrl: string): Promise<void> {
    try {
      const { toDataURL } = await import('qrcode');
      const dataUrl = await toDataURL(shareUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 256,
        color: {
          dark: '#09090b',
          light: '#f4f4f5',
        },
      });

      if (this.game.shareUrl() === shareUrl) {
        this.qrCodeDataUrl.set(dataUrl);
      }
    } catch {
      this.qrCodeDataUrl.set('');
    }
  }

  private capitalize(value: string): string {
    return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  }
}
