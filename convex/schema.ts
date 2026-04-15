import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const cellValueValidator = v.union(v.literal('X'), v.literal('O'), v.null());
const playerSymbolValidator = v.union(v.literal('X'), v.literal('O'));
const winnerValidator = v.union(v.literal('X'), v.literal('O'), v.literal('draw'), v.null());

const snapshotValidator = v.object({
  board: v.array(cellValueValidator),
  currentTurn: playerSymbolValidator,
  winner: winnerValidator,
  winningLine: v.array(v.number()),
});

const schema = defineSchema({
  rooms: defineTable({
    roomId: v.string(),
    snapshot: snapshotValidator,
    hostSessionId: v.optional(v.string()),
    guestSessionId: v.optional(v.string()),
    hostLastSeenAt: v.optional(v.number()),
    guestLastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_room_id', ['roomId']),
});

export default schema;
