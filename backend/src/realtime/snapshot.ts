import { pool } from '../db/pool.js';

export type SeatStatus = 'available' | 'reserved' | 'booked';

/** One seat as the client sees it: layout position plus its current occupancy. */
export interface SeatView {
  id: number;
  row: number;
  number: number;
  status: SeatStatus;
  userId: number | null;
  expiresAt: string | null;
}

/**
 * Raw shape of a snapshot row. The reservation columns are nullable because the
 * join is a LEFT JOIN whose ON clause filters out inactive reservations.
 */
interface SnapshotRow {
  id: number;
  row: number;
  number: number;
  r_status: string | null;
  user_id: number | null;
  expires_at: Date | string | null;
}

/**
 * Single-query snapshot with *lazy* expiry: a seat counts as occupied only when
 * it is attached to a `booked` reservation, or to a `held` one that has not run
 * out yet. The expiry test lives in the JOIN's ON clause on purpose — moving it
 * into WHERE would drop every unoccupied seat from the result instead of just
 * nulling the reservation columns.
 */
const SNAPSHOT_SQL = `
  SELECT s.id, s.row_number AS row, s.seat_number AS number,
         r.status AS r_status, r.user_id, r.expires_at
  FROM seats s
  LEFT JOIN reservation_seats rs ON rs.seat_id = s.id
  LEFT JOIN reservations r ON r.id = rs.reservation_id
    AND (r.status = 'booked' OR (r.status = 'held' AND r.expires_at > clock_timestamp()))
  WHERE s.instance_id = $1
  ORDER BY s.row_number, s.seat_number
`;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSeatView(row: SnapshotRow): SeatView {
  const status: SeatStatus =
    row.r_status === 'booked' ? 'booked' : row.r_status === 'held' ? 'reserved' : 'available';
  const occupied = status !== 'available';
  return {
    id: row.id,
    row: row.row,
    number: row.number,
    status,
    userId: occupied ? row.user_id : null,
    expiresAt: occupied ? toIso(row.expires_at) : null,
  };
}

/**
 * Full seat map for one instance, ordered by row then seat number.
 *
 * A seat that was part of several reservations over time yields one row per
 * `reservation_seats` link, and only the still-active one keeps its reservation
 * columns. We therefore collapse by seat id, always preferring the occupied
 * match so a stale duplicate can never mask a live hold or booking.
 */
export async function getSnapshot(instanceId: number): Promise<SeatView[]> {
  const result = await pool.query<SnapshotRow>(SNAPSHOT_SQL, [instanceId]);

  const bySeatId = new Map<number, SeatView>();
  for (const row of result.rows) {
    const seat = toSeatView(row);
    const existing = bySeatId.get(seat.id);
    if (existing === undefined || existing.status === 'available') {
      bySeatId.set(seat.id, seat);
    }
  }
  return [...bySeatId.values()];
}
