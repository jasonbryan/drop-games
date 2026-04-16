export type GameSlug = 'tic-tac-toe' | 'yahtzee';

export interface GameDefinition {
  slug: GameSlug;
  title: string;
  description: string;
  badge: string;
}

export const GAME_CATALOG: GameDefinition[] = [
  {
    slug: 'tic-tac-toe',
    title: 'Tic Tac Toe',
    description: 'Classic 3x3 strategy game. Two players, fast rounds.',
    badge: 'Quick',
  },
  {
    slug: 'yahtzee',
    title: 'Yahtzee',
    description: 'Roll and score across 13 categories with full rules.',
    badge: 'Classic',
  },
];

export function getGameDefinition(gameSlug: string): GameDefinition | null {
  return GAME_CATALOG.find((game) => game.slug === gameSlug) ?? null;
}
