import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import { createTicTacToeGame, getTicTacToeGameByRoomId, makeTicTacToeMove, resetTicTacToeGame } from './games/ticTacToe';
import {
  createYahtzeeGame,
  getYahtzeeGameByRoomId,
  resetYahtzeeGame,
  rollYahtzeeDice,
  scoreYahtzeeCategory,
  toggleYahtzeeDieHold,
} from './games/yahtzee';
import {
  claimParticipantSlot,
  getRoleForSession,
  getRoomById,
  isParticipantActive,
  normalizeRoomId,
  normalizeSessionId,
  updatePresence,
  type ParticipantRole,
} from './lib/rooms';
type RoomDoc = Doc<'rooms'>;
type GameSlug = 'tic-tac-toe' | 'yahtzee';

interface RoomView {
  roomId: string;
  gameSlug: 'tic-tac-toe' | 'yahtzee';
  role: ParticipantRole | null;
  playerSymbol: 'X' | 'O' | null;
  hostOccupied: boolean;
  guestOccupied: boolean;
  hostLastSeenAt: number | null;
  guestLastSeenAt: number | null;
  updatedAt: number;
  ticTacToeSnapshot:
    | {
        board: ('X' | 'O' | null)[];
        currentTurn: 'X' | 'O';
        winner: 'X' | 'O' | 'draw' | null;
        winningLine: number[];
      }
    | null;
  yahtzeeState: {
    currentTurn: ParticipantRole;
    rollNumber: number;
    dice: number[];
    heldDice: boolean[];
    scorecardHost: Record<string, number | null>;
    scorecardGuest: Record<string, number | null>;
    upperBonusHost: number;
    upperBonusGuest: number;
    yahtzeeBonusHost: number;
    yahtzeeBonusGuest: number;
    winner: ParticipantRole | 'draw' | null;
  } | null;
}

interface SyncParticipantResult {
  role: ParticipantRole | null;
  playerSymbol: 'X' | 'O' | null;
  gameSlug: GameSlug;
}

const playerRoleValidator = v.union(v.literal('host'), v.literal('guest'));
const playerSymbolValidator = v.union(v.literal('X'), v.literal('O'));
const cellValueValidator = v.union(v.literal('X'), v.literal('O'), v.null());
const winnerValidator = v.union(v.literal('X'), v.literal('O'), v.literal('draw'), v.null());
const roomModeValidator = v.union(v.literal('auto'), v.literal('guest'));
const gameSlugValidator = v.union(v.literal('tic-tac-toe'), v.literal('yahtzee'));

const snapshotValidator = v.object({
  board: v.array(cellValueValidator),
  currentTurn: playerSymbolValidator,
  winner: winnerValidator,
  winningLine: v.array(v.number()),
});

const roomViewValidator = v.object({
  roomId: v.string(),
  gameSlug: gameSlugValidator,
  role: v.union(v.literal('host'), v.literal('guest'), v.null()),
  playerSymbol: v.union(v.literal('X'), v.literal('O'), v.null()),
  hostOccupied: v.boolean(),
  guestOccupied: v.boolean(),
  hostLastSeenAt: v.union(v.number(), v.null()),
  guestLastSeenAt: v.union(v.number(), v.null()),
  updatedAt: v.number(),
  ticTacToeSnapshot: v.union(snapshotValidator, v.null()),
  yahtzeeState: v.union(
    v.object({
      currentTurn: playerRoleValidator,
      rollNumber: v.number(),
      dice: v.array(v.number()),
      heldDice: v.array(v.boolean()),
      scorecardHost: v.record(v.string(), v.union(v.number(), v.null())),
      scorecardGuest: v.record(v.string(), v.union(v.number(), v.null())),
      upperBonusHost: v.number(),
      upperBonusGuest: v.number(),
      yahtzeeBonusHost: v.number(),
      yahtzeeBonusGuest: v.number(),
      winner: v.union(playerRoleValidator, v.literal('draw'), v.null()),
    }),
    v.null(),
  ),
});

const syncParticipantResultValidator = v.object({
  role: v.union(playerRoleValidator, v.null()),
  playerSymbol: v.union(playerSymbolValidator, v.null()),
  gameSlug: gameSlugValidator,
});

export const watchRoom = query({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
  },
  returns: v.union(roomViewValidator, v.null()),
  handler: async (ctx, args): Promise<RoomView | null> => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);

    if (room === null) {
      return null;
    }

    return await buildRoomView(ctx, room, sessionId);
  },
});

export const syncParticipant = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
    mode: roomModeValidator,
    gameSlug: gameSlugValidator,
  },
  returns: syncParticipantResultValidator,
  handler: async (ctx, args): Promise<SyncParticipantResult> => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const now = Date.now();
    const existingRoom = await getRoomById(ctx, roomId);

    if (existingRoom === null) {
      if (args.mode === 'guest') {
        throw new Error('The room host is offline. Ask them to open the room link again.');
      }

      await ctx.db.insert('rooms', {
        roomId,
        gameSlug: args.gameSlug,
        hostSessionId: sessionId,
        guestSessionId: undefined,
        hostLastSeenAt: now,
        guestLastSeenAt: undefined,
        createdAt: now,
        updatedAt: now,
      });
      if (args.gameSlug === 'tic-tac-toe') {
        await createTicTacToeGame(ctx, roomId, now);
      } else {
        await createYahtzeeGame(ctx, roomId, now);
      }

      return {
        role: 'host',
        playerSymbol: 'X',
        gameSlug: args.gameSlug,
      };
    }

    const existingGameSlug = existingRoom.gameSlug ?? 'tic-tac-toe';
    if (existingGameSlug !== args.gameSlug) {
      throw new Error('Room link is for a different game type.');
    }

    const currentRole = getRoleForSession(existingRoom, sessionId);
    if (currentRole !== null) {
      await updatePresence(ctx, existingRoom._id, currentRole, now);
      return toSyncResult(currentRole, existingGameSlug);
    }

    const hostActive = isParticipantActive(existingRoom.hostLastSeenAt, now);
    const guestActive = isParticipantActive(existingRoom.guestLastSeenAt, now);
    const hostAvailable = !existingRoom.hostSessionId || !hostActive;
    const guestAvailable = !existingRoom.guestSessionId || !guestActive;

    if (args.mode === 'guest') {
      if (!hostActive) {
        throw new Error('The room host is offline. Ask them to open the room link again.');
      }

      if (!guestAvailable) {
        return {
          role: null,
          playerSymbol: null,
          gameSlug: existingGameSlug,
        };
      }

      await claimParticipantSlot(ctx, existingRoom._id, 'guest', sessionId, now);
      return {
        role: 'guest',
        playerSymbol: 'O',
        gameSlug: existingGameSlug,
      };
    }

    if (hostAvailable) {
      await claimParticipantSlot(ctx, existingRoom._id, 'host', sessionId, now);
      return {
        role: 'host',
        playerSymbol: 'X',
        gameSlug: existingGameSlug,
      };
    }

    if (guestAvailable) {
      await claimParticipantSlot(ctx, existingRoom._id, 'guest', sessionId, now);
      return {
        role: 'guest',
        playerSymbol: 'O',
        gameSlug: existingGameSlug,
      };
    }

    return {
      role: null,
      playerSymbol: null,
      gameSlug: existingGameSlug,
    };
  },
});

export const sendHeartbeat = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);

    if (room === null) {
      return false;
    }

    const role = getRoleForSession(room, sessionId);
    if (role === null) {
      return false;
    }

    await updatePresence(ctx, room._id, role, Date.now());
    return true;
  },
});

export const makeMove = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
    index: v.number(),
  },
  returns: snapshotValidator,
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);

    if (room === null) {
      throw new Error('The room is no longer available.');
    }

    const role = getRoleForSession(room, sessionId);
    if (role === null) {
      throw new Error('You are no longer connected to this room.');
    }

    if ((room.gameSlug ?? 'tic-tac-toe') !== 'tic-tac-toe') {
      throw new Error('makeMove is only available for Tic Tac Toe rooms.');
    }
    const nextSnapshot = await makeTicTacToeMove(ctx, roomId, args.index, getPlayerSymbolForRole(role));
    await updatePresence(ctx, room._id, role, Date.now());
    return nextSnapshot;
  },
});

export const resetGame = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
  },
  returns: v.union(snapshotValidator, v.null()),
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);

    if (room === null) {
      throw new Error('The room is no longer available.');
    }

    const role = getRoleForSession(room, sessionId);
    if (role === null) {
      throw new Error('You are no longer connected to this room.');
    }

    await updatePresence(ctx, room._id, role, Date.now());
    if ((room.gameSlug ?? 'tic-tac-toe') === 'tic-tac-toe') {
      return await resetTicTacToeGame(ctx, roomId);
    }
    await resetYahtzeeGame(ctx, roomId);
    return null;
  },
});

export const rollYahtzee = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);
    if (!room || (room.gameSlug ?? 'tic-tac-toe') !== 'yahtzee') {
      throw new Error('Room does not support Yahtzee rolls.');
    }
    const role = getRoleForSession(room, sessionId);
    if (!role) {
      throw new Error('Spectators cannot roll dice.');
    }
    await rollYahtzeeDice(ctx, roomId, role);
    await updatePresence(ctx, room._id, role, Date.now());
    return true;
  },
});

export const toggleYahtzeeHold = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
    dieIndex: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);
    if (!room || (room.gameSlug ?? 'tic-tac-toe') !== 'yahtzee') {
      throw new Error('Room does not support Yahtzee holds.');
    }
    const role = getRoleForSession(room, sessionId);
    if (!role) {
      throw new Error('Spectators cannot hold dice.');
    }
    await toggleYahtzeeDieHold(ctx, roomId, role, args.dieIndex);
    await updatePresence(ctx, room._id, role, Date.now());
    return true;
  },
});

export const scoreYahtzee = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
    category: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);
    if (!room || (room.gameSlug ?? 'tic-tac-toe') !== 'yahtzee') {
      throw new Error('Room does not support Yahtzee scoring.');
    }
    const role = getRoleForSession(room, sessionId);
    if (!role) {
      throw new Error('Spectators cannot submit scores.');
    }
    await scoreYahtzeeCategory(ctx, roomId, role, args.category);
    await updatePresence(ctx, room._id, role, Date.now());
    return true;
  },
});

export const leaveRoom = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const roomId = normalizeRoomId(args.roomId);
    const sessionId = normalizeSessionId(args.sessionId);
    const room = await getRoomById(ctx, roomId);

    if (room === null) {
      return false;
    }

    const role = getRoleForSession(room, sessionId);
    if (role === null) {
      return false;
    }

    if (role === 'host') {
      const hasGuest = Boolean(room.guestSessionId);

      if (!hasGuest) {
        await ctx.db.delete(room._id);
        return true;
      }

      await ctx.db.patch(room._id, {
        hostSessionId: undefined,
        hostLastSeenAt: undefined,
        updatedAt: Date.now(),
      });
      return true;
    }

    const hasHost = Boolean(room.hostSessionId);

    if (!hasHost) {
      await ctx.db.delete(room._id);
      return true;
    }

    await ctx.db.patch(room._id, {
      guestSessionId: undefined,
      guestLastSeenAt: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

async function buildRoomView(
  ctx: QueryCtx | MutationCtx,
  room: RoomDoc,
  sessionId: string,
): Promise<RoomView> {
  const role = getRoleForSession(room, sessionId);
  const gameSlug = room.gameSlug ?? 'tic-tac-toe';
  const ticTacToeGame =
    gameSlug === 'tic-tac-toe' ? await getTicTacToeGameByRoomId(ctx, room.roomId) : null;
  const yahtzeeGame = gameSlug === 'yahtzee' ? await getYahtzeeGameByRoomId(ctx, room.roomId) : null;

  return {
    roomId: room.roomId,
    gameSlug,
    role,
    playerSymbol: role === null ? null : getPlayerSymbolForRole(role),
    hostOccupied: Boolean(room.hostSessionId),
    guestOccupied: Boolean(room.guestSessionId),
    hostLastSeenAt: room.hostLastSeenAt ?? null,
    guestLastSeenAt: room.guestLastSeenAt ?? null,
    updatedAt: room.updatedAt,
    ticTacToeSnapshot: ticTacToeGame?.snapshot ?? null,
    yahtzeeState: yahtzeeGame
      ? {
          currentTurn: yahtzeeGame.currentTurn,
          rollNumber: yahtzeeGame.rollNumber,
          dice: yahtzeeGame.dice,
          heldDice: yahtzeeGame.heldDice,
          scorecardHost: yahtzeeGame.scorecardHost,
          scorecardGuest: yahtzeeGame.scorecardGuest,
          upperBonusHost: yahtzeeGame.upperBonusHost,
          upperBonusGuest: yahtzeeGame.upperBonusGuest,
          yahtzeeBonusHost: yahtzeeGame.yahtzeeBonusHost,
          yahtzeeBonusGuest: yahtzeeGame.yahtzeeBonusGuest,
          winner: yahtzeeGame.winner,
        }
      : null,
  };
}

function getPlayerSymbolForRole(role: ParticipantRole): 'X' | 'O' {
  return role === 'host' ? 'X' : 'O';
}

function toSyncResult(role: ParticipantRole, gameSlug: GameSlug): SyncParticipantResult {
  return {
    role,
    playerSymbol: getPlayerSymbolForRole(role),
    gameSlug,
  };
}
