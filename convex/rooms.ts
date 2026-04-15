import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';

import {
  applyMove,
  createInitialSnapshot,
  type GameSnapshot,
  type PlayerSymbol,
} from '../src/app/core/game/tic-tac-toe';

type ParticipantRole = 'host' | 'guest';
type RoomDoc = Doc<'rooms'>;

interface RoomView {
  roomId: string;
  snapshot: GameSnapshot;
  role: ParticipantRole | null;
  playerSymbol: PlayerSymbol | null;
  hostOccupied: boolean;
  guestOccupied: boolean;
  hostLastSeenAt: number | null;
  guestLastSeenAt: number | null;
  updatedAt: number;
}

interface SyncParticipantResult {
  role: ParticipantRole;
  playerSymbol: PlayerSymbol;
}

const playerRoleValidator = v.union(v.literal('host'), v.literal('guest'));
const playerSymbolValidator = v.union(v.literal('X'), v.literal('O'));
const cellValueValidator = v.union(v.literal('X'), v.literal('O'), v.null());
const winnerValidator = v.union(v.literal('X'), v.literal('O'), v.literal('draw'), v.null());
const roomModeValidator = v.union(v.literal('auto'), v.literal('guest'));

const snapshotValidator = v.object({
  board: v.array(cellValueValidator),
  currentTurn: playerSymbolValidator,
  winner: winnerValidator,
  winningLine: v.array(v.number()),
});

const roomViewValidator = v.object({
  roomId: v.string(),
  snapshot: snapshotValidator,
  role: v.union(v.literal('host'), v.literal('guest'), v.null()),
  playerSymbol: v.union(v.literal('X'), v.literal('O'), v.null()),
  hostOccupied: v.boolean(),
  guestOccupied: v.boolean(),
  hostLastSeenAt: v.union(v.number(), v.null()),
  guestLastSeenAt: v.union(v.number(), v.null()),
  updatedAt: v.number(),
});

const syncParticipantResultValidator = v.object({
  role: playerRoleValidator,
  playerSymbol: playerSymbolValidator,
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

    return buildRoomView(room, sessionId);
  },
});

export const syncParticipant = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
    mode: roomModeValidator,
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

      const snapshot = createInitialSnapshot();
      await ctx.db.insert('rooms', {
        roomId,
        snapshot,
        hostSessionId: sessionId,
        guestSessionId: undefined,
        hostLastSeenAt: now,
        guestLastSeenAt: undefined,
        createdAt: now,
        updatedAt: now,
      });

      return {
        role: 'host',
        playerSymbol: 'X',
      };
    }

    const currentRole = getRoleForSession(existingRoom, sessionId);
    if (currentRole !== null) {
      await updatePresence(ctx, existingRoom._id, currentRole, now);
      return toSyncResult(currentRole);
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
        throw new Error('This room already has two players.');
      }

      await claimParticipantSlot(ctx, existingRoom._id, 'guest', sessionId, now);
      return {
        role: 'guest',
        playerSymbol: 'O',
      };
    }

    if (hostAvailable) {
      await claimParticipantSlot(ctx, existingRoom._id, 'host', sessionId, now);
      return {
        role: 'host',
        playerSymbol: 'X',
      };
    }

    if (guestAvailable) {
      await claimParticipantSlot(ctx, existingRoom._id, 'guest', sessionId, now);
      return {
        role: 'guest',
        playerSymbol: 'O',
      };
    }

    throw new Error('This room already has two active players.');
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
  handler: async (ctx, args): Promise<GameSnapshot> => {
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

    const nextSnapshot = applyMove(room.snapshot, args.index, getPlayerSymbolForRole(role));
    if (areSnapshotsEqual(nextSnapshot, room.snapshot)) {
      return room.snapshot;
    }

    const now = Date.now();
    await ctx.db.patch(room._id, {
      snapshot: nextSnapshot,
      updatedAt: now,
      ...(role === 'host' ? { hostLastSeenAt: now } : { guestLastSeenAt: now }),
    });

    return nextSnapshot;
  },
});

export const resetGame = mutation({
  args: {
    roomId: v.string(),
    sessionId: v.string(),
  },
  returns: snapshotValidator,
  handler: async (ctx, args): Promise<GameSnapshot> => {
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

    const snapshot = createInitialSnapshot();
    const now = Date.now();

    await ctx.db.patch(room._id, {
      snapshot,
      updatedAt: now,
      ...(role === 'host' ? { hostLastSeenAt: now } : { guestLastSeenAt: now }),
    });

    return snapshot;
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

async function getRoomById(ctx: QueryCtx | MutationCtx, roomId: string): Promise<RoomDoc | null> {
  return await ctx.db
    .query('rooms')
    .withIndex('by_room_id', (queryBuilder) => queryBuilder.eq('roomId', roomId))
    .unique();
}

function normalizeRoomId(roomId: string): string {
  const normalized = roomId.trim().toLowerCase();

  if (!normalized) {
    throw new Error('Invalid room link.');
  }

  return normalized;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();

  if (!normalized) {
    throw new Error('Invalid player session.');
  }

  return normalized;
}

function buildRoomView(room: RoomDoc, sessionId: string): RoomView {
  const role = getRoleForSession(room, sessionId);

  return {
    roomId: room.roomId,
    snapshot: room.snapshot,
    role,
    playerSymbol: role === null ? null : getPlayerSymbolForRole(role),
    hostOccupied: Boolean(room.hostSessionId),
    guestOccupied: Boolean(room.guestSessionId),
    hostLastSeenAt: room.hostLastSeenAt ?? null,
    guestLastSeenAt: room.guestLastSeenAt ?? null,
    updatedAt: room.updatedAt,
  };
}

function getRoleForSession(room: RoomDoc, sessionId: string): ParticipantRole | null {
  if (room.hostSessionId === sessionId) {
    return 'host';
  }

  if (room.guestSessionId === sessionId) {
    return 'guest';
  }

  return null;
}

function getPlayerSymbolForRole(role: ParticipantRole): PlayerSymbol {
  return role === 'host' ? 'X' : 'O';
}

function isParticipantActive(lastSeenAt: number | undefined, now: number): boolean {
  return typeof lastSeenAt === 'number' && now - lastSeenAt < 12_000;
}

async function updatePresence(
  ctx: MutationCtx,
  roomDocumentId: RoomDoc['_id'],
  role: ParticipantRole,
  now: number,
): Promise<void> {
  await ctx.db.patch(roomDocumentId, {
    ...(role === 'host' ? { hostLastSeenAt: now } : { guestLastSeenAt: now }),
    updatedAt: now,
  });
}

async function claimParticipantSlot(
  ctx: MutationCtx,
  roomDocumentId: RoomDoc['_id'],
  role: ParticipantRole,
  sessionId: string,
  now: number,
): Promise<void> {
  await ctx.db.patch(roomDocumentId, {
    ...(role === 'host'
      ? {
          hostSessionId: sessionId,
          hostLastSeenAt: now,
        }
      : {
          guestSessionId: sessionId,
          guestLastSeenAt: now,
        }),
    updatedAt: now,
  });
}

function toSyncResult(role: ParticipantRole): SyncParticipantResult {
  return {
    role,
    playerSymbol: getPlayerSymbolForRole(role),
  };
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
