import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GAME_CATALOG, type GameSlug, getGameDefinition } from '../../games/catalog';

@Component({
  selector: 'app-home-page',
  imports: [FormsModule],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
})
export class HomePageComponent {
  protected readonly joinValue = signal('');
  protected readonly games = GAME_CATALOG;
  protected readonly selectedGameSlug = signal<GameSlug>('tic-tac-toe');

  constructor(private readonly router: Router) {}

  protected async createGame(gameSlug: GameSlug): Promise<void> {
    const roomId = this.generateRoomId();
    await this.router.navigate(['/play', gameSlug, roomId]);
  }

  protected async joinGame(): Promise<void> {
    const normalized = this.normalizeRoomInput(this.joinValue());

    if (!normalized) {
      return;
    }

    this.selectedGameSlug.set(normalized.gameSlug);

    await this.router.navigate(['/play', normalized.gameSlug, normalized.roomId], {
      queryParams: { join: 1 },
    });
  }

  protected updateJoinValue(value: string): void {
    this.joinValue.set(value);
  }

  private generateRoomId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().split('-')[0];
    }

    return Math.random().toString(36).slice(2, 10);
  }

  private normalizeRoomInput(value: string): { roomId: string; gameSlug: GameSlug } | null {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split('/').filter(Boolean);
      const maybeRoomId = segments.at(-1)?.toLowerCase() ?? '';
      const maybeGameSlug = segments.at(-2)?.toLowerCase() ?? '';
      const game = getGameDefinition(maybeGameSlug);
      const roomId = maybeRoomId.replace(/[^a-z0-9-]/g, '');

      if (!roomId) {
        return null;
      }

      return {
        roomId,
        gameSlug: game?.slug ?? this.selectedGameSlug(),
      };
    } catch {
      const roomId = trimmed.toLowerCase().replace(/[^a-z0-9-]/g, '');
      return roomId
        ? {
            roomId,
            gameSlug: this.selectedGameSlug(),
          }
        : null;
    }
  }
}
