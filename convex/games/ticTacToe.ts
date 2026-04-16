import type { MutationCtx, QueryCtx } from '../_generated/server';
import { applyMove, createInitialSnapshot, type GameSnapshot, type PlayerSymbol } from '../../src/app/core/game/tic-tac-toe';

export async function getTicTacToeGameByRoomId(ctx: MutationCtx | QueryCtx, roomId: string) {
  return await ctx.db
    .query('ticTacToeGames')
    .withIndex('by_room_id', (queryBuilder) => queryBuilder.eq('roomId', roomId))
    .unique();
}

export async function createTicTacToeGame(ctx: MutationCtx, roomId: string, now: number): Promise<void> {
  await ctx.db.insert('ticTacToeGames', {
    roomId,
    snapshot: createInitialSnapshot(),
    createdAt: now,
    updatedAt: now,
  });
}

export async function makeTicTacToeMove(
  ctx: MutationCtx,
  roomId: string,
  index: number,
  player: PlayerSymbol,
): Promise<GameSnapshot> {
  const game = await getTicTacToeGameByRoomId(ctx, roomId);
  if (!game) {
    throw new Error('The Tic Tac Toe game was not found for this room.');
  }

  const nextSnapshot = applyMove(game.snapshot, index, player);
  if (areSnapshotsEqual(nextSnapshot, game.snapshot)) {
    return game.snapshot;
  }

  await ctx.db.patch(game._id, {
    snapshot: nextSnapshot,
    updatedAt: Date.now(),
  });

  return nextSnapshot;
}

export async function resetTicTacToeGame(ctx: MutationCtx, roomId: string): Promise<GameSnapshot> {
  const game = await getTicTacToeGameByRoomId(ctx, roomId);
  if (!game) {
    throw new Error('The Tic Tac Toe game was not found for this room.');
  }

  const snapshot = createInitialSnapshot();
  await ctx.db.patch(game._id, {
    snapshot,
    updatedAt: Date.now(),
  });
  return snapshot;
}

function areSnapshotsEqual(left: GameSnapshot, right: GameSnapshot): boolean {
  if (
    left.currentTurn !== right.currentTurn ||
    left.winner !== right.winner ||
    left.board.length !== right.board.length ||
    left.winningLine.length !== right.winningLine.length
  ) {
    return false;
  }

  for (let index = 0; index < left.board.length; index += 1) {
    if (left.board[index] !== right.board[index]) {
      return false;
    }
  }
  for (let index = 0; index < left.winningLine.length; index += 1) {
    if (left.winningLine[index] !== right.winningLine[index]) {
      return false;
    }
  }
  return true;
}
