import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/home/home-page').then((module) => module.HomePageComponent),
  },
  {
    path: 'play/:gameSlug/:roomId',
    loadComponent: () =>
      import('./features/game/game-page').then((module) => module.GamePageComponent),
  },
  {
    path: 'game/:roomId',
    redirectTo: 'play/tic-tac-toe/:roomId',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
