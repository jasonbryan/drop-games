import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

type ParticipantRole = 'host' | 'guest';
type YahtzeeCategory =
  | 'ones'
  | 'twos'
  | 'threes'
  | 'fours'
  | 'fives'
  | 'sixes'
  | 'threeOfAKind'
  | 'fourOfAKind'
  | 'fullHouse'
  | 'smallStraight'
  | 'largeStraight'
  | 'yahtzee'
  | 'chance';

const ALL_CATEGORIES: YahtzeeCategory[] = [
  'ones',
  'twos',
  'threes',
  'fours',
  'fives',
  'sixes',
  'threeOfAKind',
  'fourOfAKind',
  'fullHouse',
  'smallStraight',
  'largeStraight',
  'yahtzee',
  'chance',
];

const UPPER_CATEGORIES = new Set<YahtzeeCategory>(['ones', 'twos', 'threes', 'fours', 'fives', 'sixes']);

type YahtzeeGameDoc = Doc<'yahtzeeGames'>;

export async function getYahtzeeGameByRoomId(
  ctx: MutationCtx | QueryCtx,
  roomId: string,
): Promise<YahtzeeGameDoc | null> {
  return await ctx.db
    .query('yahtzeeGames')
    .withIndex('by_room_id', (queryBuilder) => queryBuilder.eq('roomId', roomId))
    .unique();
}

export async function createYahtzeeGame(ctx: MutationCtx, roomId: string, now: number): Promise<void> {
  const blankScorecard = createBlankScorecard();
  await ctx.db.insert('yahtzeeGames', {
    roomId,
    currentTurn: 'host',
    rollNumber: 0,
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    scorecardHost: blankScorecard,
    scorecardGuest: blankScorecard,
    upperBonusHost: 0,
    upperBonusGuest: 0,
    yahtzeeBonusHost: 0,
    yahtzeeBonusGuest: 0,
    winner: null,
    rngSeed: hashString(roomId),
    createdAt: now,
    updatedAt: now,
  });
}

export async function toggleYahtzeeDieHold(
  ctx: MutationCtx,
  roomId: string,
  role: ParticipantRole,
  index: number,
): Promise<YahtzeeGameDoc> {
  const game = await getRequiredGame(ctx, roomId);
  validateTurn(game, role);
  if (!Number.isInteger(index) || index < 0 || index >= game.heldDice.length) {
    throw new Error('Invalid die index.');
  }
  if (game.rollNumber === 0) {
    throw new Error('Roll first before holding dice.');
  }
  const heldDice = [...game.heldDice];
  heldDice[index] = !heldDice[index];
  await ctx.db.patch(game._id, { heldDice, updatedAt: Date.now() });
  return { ...game, heldDice };
}

export async function rollYahtzeeDice(
  ctx: MutationCtx,
  roomId: string,
  role: ParticipantRole,
): Promise<YahtzeeGameDoc> {
  const game = await getRequiredGame(ctx, roomId);
  validateTurn(game, role);
  if (game.rollNumber >= 3) {
    throw new Error('No rolls remaining this turn.');
  }

  const dice = [...game.dice];
  let nextSeed = game.rngSeed;
  for (let index = 0; index < dice.length; index += 1) {
    if (game.rollNumber === 0 || !game.heldDice[index]) {
      const [value, seed] = nextDieValue(nextSeed);
      dice[index] = value;
      nextSeed = seed;
    }
  }

  const rollNumber = game.rollNumber + 1;
  await ctx.db.patch(game._id, {
    dice,
    rollNumber,
    rngSeed: nextSeed,
    updatedAt: Date.now(),
  });
  return { ...game, dice, rollNumber, rngSeed: nextSeed };
}

export async function scoreYahtzeeCategory(
  ctx: MutationCtx,
  roomId: string,
  role: ParticipantRole,
  category: string,
): Promise<YahtzeeGameDoc> {
  if (!isCategory(category)) {
    throw new Error('Invalid Yahtzee category.');
  }

  const game = await getRequiredGame(ctx, roomId);
  validateTurn(game, role);
  if (game.rollNumber === 0) {
    throw new Error('Roll before scoring a category.');
  }

  const scorecard = role === 'host' ? { ...game.scorecardHost } : { ...game.scorecardGuest };
  if (scorecard[category] !== null) {
    throw new Error('This category is already scored.');
  }

  const score = scoreForCategory(category, game.dice);
  scorecard[category] = score;
  const upperBonus = computeUpperBonus(scorecard);
  const yahtzeeBonus = computeYahtzeeBonus(scorecard, game.dice, category);

  const patch: Partial<YahtzeeGameDoc> = {
    currentTurn: role === 'host' ? 'guest' : 'host',
    rollNumber: 0,
    heldDice: [false, false, false, false, false],
    updatedAt: Date.now(),
  };

  if (role === 'host') {
    patch.scorecardHost = scorecard;
    patch.upperBonusHost = upperBonus;
    patch.yahtzeeBonusHost = game.yahtzeeBonusHost + yahtzeeBonus;
  } else {
    patch.scorecardGuest = scorecard;
    patch.upperBonusGuest = upperBonus;
    patch.yahtzeeBonusGuest = game.yahtzeeBonusGuest + yahtzeeBonus;
  }

  const hostComplete = isScorecardComplete(role === 'host' ? scorecard : game.scorecardHost);
  const guestComplete = isScorecardComplete(role === 'guest' ? scorecard : game.scorecardGuest);
  if (hostComplete && guestComplete) {
    const hostTotal =
      totalScore(role === 'host' ? scorecard : game.scorecardHost) +
      (role === 'host' ? upperBonus : game.upperBonusHost) +
      (role === 'host' ? game.yahtzeeBonusHost + yahtzeeBonus : game.yahtzeeBonusHost);
    const guestTotal =
      totalScore(role === 'guest' ? scorecard : game.scorecardGuest) +
      (role === 'guest' ? upperBonus : game.upperBonusGuest) +
      (role === 'guest' ? game.yahtzeeBonusGuest + yahtzeeBonus : game.yahtzeeBonusGuest);
    patch.winner = hostTotal === guestTotal ? 'draw' : hostTotal > guestTotal ? 'host' : 'guest';
  }

  await ctx.db.patch(game._id, patch);
  return { ...game, ...patch } as YahtzeeGameDoc;
}

export async function resetYahtzeeGame(ctx: MutationCtx, roomId: string): Promise<YahtzeeGameDoc> {
  const game = await getRequiredGame(ctx, roomId);
  const blank = createBlankScorecard();
  const patch: Partial<YahtzeeGameDoc> = {
    currentTurn: 'host',
    rollNumber: 0,
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    scorecardHost: blank,
    scorecardGuest: blank,
    upperBonusHost: 0,
    upperBonusGuest: 0,
    yahtzeeBonusHost: 0,
    yahtzeeBonusGuest: 0,
    winner: null,
    rngSeed: hashString(`${roomId}-${Date.now()}`),
    updatedAt: Date.now(),
  };
  await ctx.db.patch(game._id, patch);
  return { ...game, ...patch } as YahtzeeGameDoc;
}

function createBlankScorecard(): Record<string, number | null> {
  const scorecard: Record<string, number | null> = {};
  for (const category of ALL_CATEGORIES) {
    scorecard[category] = null;
  }
  return scorecard;
}

function isCategory(value: string): value is YahtzeeCategory {
  return ALL_CATEGORIES.includes(value as YahtzeeCategory);
}

function scoreForCategory(category: YahtzeeCategory, dice: number[]): number {
  const counts = countDice(dice);
  const sum = dice.reduce((total, value) => total + value, 0);
  switch (category) {
    case 'ones':
    case 'twos':
    case 'threes':
    case 'fours':
    case 'fives':
    case 'sixes': {
      const target = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'].indexOf(category) + 1;
      return dice.filter((value) => value === target).reduce((total, value) => total + value, 0);
    }
    case 'threeOfAKind':
      return hasCount(counts, 3) ? sum : 0;
    case 'fourOfAKind':
      return hasCount(counts, 4) ? sum : 0;
    case 'fullHouse':
      return isFullHouse(counts) ? 25 : 0;
    case 'smallStraight':
      return hasStraight(dice, 4) ? 30 : 0;
    case 'largeStraight':
      return hasStraight(dice, 5) ? 40 : 0;
    case 'yahtzee':
      return hasCount(counts, 5) ? 50 : 0;
    case 'chance':
      return sum;
  }
}

function computeUpperBonus(scorecard: Record<string, number | null>): number {
  const subtotal = ALL_CATEGORIES.filter((category) => UPPER_CATEGORIES.has(category))
    .map((category) => scorecard[category] ?? 0)
    .reduce((total, value) => total + value, 0);
  return subtotal >= 63 ? 35 : 0;
}

function computeYahtzeeBonus(
  scorecard: Record<string, number | null>,
  dice: number[],
  category: YahtzeeCategory,
): number {
  const yahtzeeScored = scorecard['yahtzee'];
  const isYahtzeeRoll = new Set(dice).size === 1;
  if (!isYahtzeeRoll || yahtzeeScored !== 50 || category === 'yahtzee') {
    return 0;
  }
  return 100;
}

function totalScore(scorecard: Record<string, number | null>): number {
  return ALL_CATEGORIES.map((category) => scorecard[category] ?? 0).reduce((total, value) => total + value, 0);
}

function isScorecardComplete(scorecard: Record<string, number | null>): boolean {
  return ALL_CATEGORIES.every((category) => scorecard[category] !== null);
}

function validateTurn(game: YahtzeeGameDoc, role: ParticipantRole): void {
  if (game.winner !== null) {
    throw new Error('This Yahtzee game is already complete.');
  }
  if (game.currentTurn !== role) {
    throw new Error('It is not your turn.');
  }
}

async function getRequiredGame(ctx: MutationCtx, roomId: string): Promise<YahtzeeGameDoc> {
  const game = await getYahtzeeGameByRoomId(ctx, roomId);
  if (!game) {
    throw new Error('The Yahtzee game was not found for this room.');
  }
  return game;
}

function hasCount(counts: Map<number, number>, target: number): boolean {
  for (const count of counts.values()) {
    if (count >= target) {
      return true;
    }
  }
  return false;
}

function isFullHouse(counts: Map<number, number>): boolean {
  const values = [...counts.values()].sort((left, right) => left - right);
  return values.length === 2 && values[0] === 2 && values[1] === 3;
}

function hasStraight(dice: number[], length: 4 | 5): boolean {
  const uniqueSorted = [...new Set(dice)].sort((left, right) => left - right);
  let streak = 1;
  let best = 1;
  for (let index = 1; index < uniqueSorted.length; index += 1) {
    if (uniqueSorted[index] === uniqueSorted[index - 1] + 1) {
      streak += 1;
      if (streak > best) {
        best = streak;
      }
    } else {
      streak = 1;
    }
  }
  return best >= length;
}

function countDice(dice: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of dice) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextDieValue(seed: number): [number, number] {
  let next = seed >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  return [(next % 6) + 1, next];
}
