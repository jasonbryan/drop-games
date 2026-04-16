import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

export type RoomDoc = Doc<'rooms'>;
export type ParticipantRole = 'host' | 'guest';

export function normalizeRoomId(roomId: string): string {
  const normalized = roomId.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Invalid room link.');
  }
  return normalized;
}

export function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error('Invalid player session.');
  }
  return normalized;
}

export async function getRoomById(
  ctx: QueryCtx | MutationCtx,
  roomId: string,
): Promise<RoomDoc | null> {
  return await ctx.db
    .query('rooms')
    .withIndex('by_room_id', (queryBuilder) => queryBuilder.eq('roomId', roomId))
    .unique();
}

export function getRoleForSession(room: RoomDoc, sessionId: string): ParticipantRole | null {
  if (room.hostSessionId === sessionId) {
    return 'host';
  }
  if (room.guestSessionId === sessionId) {
    return 'guest';
  }
  return null;
}

export function isParticipantActive(lastSeenAt: number | undefined, now: number): boolean {
  return typeof lastSeenAt === 'number' && now - lastSeenAt < 12_000;
}

export async function updatePresence(
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

export async function claimParticipantSlot(
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
