import { getSnapshot } from './snapshot.js';
import type { SeatStatus, SeatView } from './snapshot.js';

/**
 * `WebSocket.OPEN`, inlined. The hub only ever needs to know whether a peer can
 * still receive, so keeping the constant local means nothing here depends on the
 * `ws` package — the transport lives entirely in `wsServer.ts`.
 */
const OPEN = 1;

/** The little the hub needs from a connected client. */
export interface HubSocket {
  readonly userId: number;
  readonly readyState: number;
  send(data: string): void;
}

/**
 * A seat as it goes over the wire. Deliberately NOT `SeatView`: the owner's
 * `userId` is replaced by a boolean, so one user can never learn who is holding
 * a seat — only whether it is theirs.
 */
export interface ClientSeatView {
  id: number;
  row: number;
  number: number;
  status: SeatStatus;
  expiresAt: string | null;
  mine: boolean;
}

/** instanceId -> the sockets currently watching it. */
const rooms = new Map<number, Set<HubSocket>>();

/**
 * instanceId -> last sequence number sent for it. Monotonic per instance and
 * per process: it exists so a client can notice it missed a delta (gap) and ask
 * for a fresh snapshot with `{type:'sync'}`. It is not persisted and not shared
 * between processes — a restart resets it, which reads as a gap and triggers
 * exactly the resync we would want anyway.
 */
const seqs = new Map<number, number>();

export function currentSeq(instanceId: number): number {
  return seqs.get(instanceId) ?? 0;
}

/** Strips the owner and answers the only ownership question a client may ask. */
export function personalize(seats: SeatView[], userId: number): ClientSeatView[] {
  return seats.map(({ userId: owner, ...seat }) => ({ ...seat, mine: owner === userId }));
}

/** Serialises and sends, unless the peer is already closing or closed. */
export function send(socket: HubSocket, message: unknown): void {
  if (socket.readyState !== OPEN) return;
  socket.send(JSON.stringify(message));
}

export function join(instanceId: number, socket: HubSocket): void {
  let room = rooms.get(instanceId);
  if (room === undefined) {
    room = new Set<HubSocket>();
    rooms.set(instanceId, room);
  }
  room.add(socket);
}

export function leave(instanceId: number, socket: HubSocket): void {
  const room = rooms.get(instanceId);
  if (room === undefined) return;
  room.delete(socket);
  // Drop empty rooms so a long-running process does not accumulate one entry
  // per instance anyone ever looked at.
  if (room.size === 0) rooms.delete(instanceId);
}

/**
 * Pushes the current seat state of `instanceId` to everyone watching it.
 *
 * The payload is the WHOLE recomputed map rather than a minimal diff: 115 seats
 * is a few kilobytes, and re-deriving from the database makes every delta
 * self-contained — a client that applies it wholesale cannot drift, whatever it
 * missed. `seats` may be passed in by a caller that already has a snapshot in
 * hand; otherwise it is read here.
 *
 * The sequence number is assigned AFTER the read, so the order of `seq` values
 * always matches the order in which frames leave this process, even when two
 * notifications overlap.
 */
export async function broadcast(instanceId: number, seats?: SeatView[]): Promise<void> {
  // Nobody is watching: skip the query entirely and leave `seq` alone. The next
  // client to connect gets a snapshot of live state either way.
  const watched = rooms.get(instanceId);
  if (watched === undefined || watched.size === 0) return;

  const state = seats ?? (await getSnapshot(instanceId));

  // Re-read the room: sockets may have come and gone during the query.
  const room = rooms.get(instanceId);
  if (room === undefined || room.size === 0) return;

  const seq = currentSeq(instanceId) + 1;
  seqs.set(instanceId, seq);

  for (const socket of room) {
    send(socket, { type: 'delta', seq, seats: personalize(state, socket.userId) });
  }
}
