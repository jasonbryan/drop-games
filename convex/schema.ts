import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const playerSlotValidator = v.union(v.literal('host'), v.literal('guest'));
const cellValueValidator = v.union(v.literal('X'), v.literal('O'), v.null());
const playerSymbolValidator = v.union(v.literal('X'), v.literal('O'));
const winnerValidator = v.union(v.literal('X'), v.literal('O'), v.literal('draw'), v.null());
const gameSlugValidator = v.union(v.literal('tic-tac-toe'), v.literal('yahtzee'));

const snapshotValidator = v.object({
  board: v.array(cellValueValidator),
  currentTurn: playerSymbolValidator,
  winner: winnerValidator,
  winningLine: v.array(v.number()),
});

const schema = defineSchema({
  rooms: defineTable({
    roomId: v.string(),
    gameSlug: v.optional(gameSlugValidator),
    snapshot: v.optional(snapshotValidator),
    hostSessionId: v.optional(v.string()),
    guestSessionId: v.optional(v.string()),
    hostLastSeenAt: v.optional(v.number()),
    guestLastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_room_id', ['roomId'])
    .index('by_game_slug', ['gameSlug']),
  ticTacToeGames: defineTable({
    roomId: v.string(),
    snapshot: snapshotValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_room_id', ['roomId']),
  yahtzeeGames: defineTable({
    roomId: v.string(),
    currentTurn: playerSlotValidator,
    rollNumber: v.number(),
    dice: v.array(v.number()),
    heldDice: v.array(v.boolean()),
    scorecardHost: v.record(v.string(), v.union(v.number(), v.null())),
    scorecardGuest: v.record(v.string(), v.union(v.number(), v.null())),
    upperBonusHost: v.number(),
    upperBonusGuest: v.number(),
    yahtzeeBonusHost: v.number(),
    yahtzeeBonusGuest: v.number(),
    winner: v.union(playerSlotValidator, v.literal('draw'), v.null()),
    rngSeed: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_room_id', ['roomId']),
});

export default schema;
