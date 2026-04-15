import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/home/home-page').then((module) => module.HomePageComponent),
  },
  {
    path: 'game/:roomId',
    loadComponent: () =>
      import('./features/game/game-page').then((module) => module.GamePageComponent),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
