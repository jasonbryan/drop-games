import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-home-page',
  imports: [FormsModule],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
})
export class HomePageComponent {
  protected readonly joinValue = signal('');

  constructor(private readonly router: Router) {}

  protected async createGame(): Promise<void> {
    const roomId = this.generateRoomId();
    await this.router.navigate(['/game', roomId]);
  }

  protected async joinGame(): Promise<void> {
    const roomId = this.normalizeRoomId(this.joinValue());

    if (!roomId) {
      return;
    }

    await this.router.navigate(['/game', roomId]);
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

  private normalizeRoomId(value: string): string | null {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split('/').filter(Boolean);
      const roomId = segments.at(-1)?.toLowerCase() ?? '';

      return roomId || null;
    } catch {
      const roomId = trimmed.toLowerCase().replace(/[^a-z0-9-]/g, '');
      return roomId || null;
    }
  }
}
