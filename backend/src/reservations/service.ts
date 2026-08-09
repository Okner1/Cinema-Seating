import type { ClientBase } from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { findTrappedSeat, isConsecutive } from './rules.js';

/**
 * An expected, client-visible failure. Carries the wire `code` and the HTTP
 * status the route should answer with, so the transaction can abort from deep
 * inside without knowing anything about Express.
 */
export class DomainError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    msg: string,
  ) {
    super(msg);
    this.name = 'DomainError';
  }
}

/** LISTEN channel for seat-state invalidation (Task 9 subscribes to it). */
export const SEAT_CHANGES_CHANNEL = 'seat_changes';

export interface ReservationResult {
  reservationId: number;
  expiresAt: string;
  seatIds: number[];
}

interface SeatRow {
  id: number;
  row_number: number;
  seat_number: number;
}

interface OccupancyRow {
  id: number;
  seat_number: number;
  occupied: boolean;
}

/**
 * Announces that the seat state of `instanceId` changed. Runs *inside* the
 * transaction: `pg_notify` is transactional, so the message is delivered only
 * if the reservation actually commits, and never before.
 *
 * The payload deliberately carries no seat state — just enough for a listener
 * to know which instance to re-derive. `pg_notify`'s payload limit is 8000
 * bytes, and a whole-map diff would risk it; the listener re-reads instead.
 */
export async function notifySeatChanges(
  client: ClientBase,
  instanceId: number,
  reservationId: number,
): Promise<void> {
  await client.query(`SELECT pg_notify($1, $2)`, [
    // pg_notify() is an ordinary function, so the channel can be a bind
    // parameter (the NOTIFY *statement* would require a literal).
    SEAT_CHANGES_CHANNEL,
    JSON.stringify({ instanceId, reservationId }),
  ]);
}

/**
 * Locks every seat of one physical row, in seat-number order.
 *
 * This single statement is THE serialization point of the whole system. Two
 * facts make it load-bearing:
 *
 *  - It covers the *entire* row, not just the requested seats. Rule 2 (no
 *    single trapped seat) is a statement about neighbours that are not being
 *    reserved, so locking only the selection would let two individually-legal
 *    holds jointly strand a seat between them.
 *  - `ORDER BY s.seat_number` fixes the lock acquisition order. A reserve only
 *    ever locks one row's seats, so a cycle is already impossible; the ordering
 *    keeps that true for later callers that reuse this statement.
 *
 * It intentionally selects nothing but the ids: see `OCCUPANCY_SQL`.
 */
const LOCK_ROW_SQL = `
  SELECT s.id
  FROM seats s
  WHERE s.instance_id = $1 AND s.row_number = $2
  ORDER BY s.seat_number
  FOR UPDATE OF s
`;

/**
 * Current occupancy of every seat of one physical row, with lazy expiry: a seat
 * is occupied iff it belongs to a `booked` reservation, or to a `held` one that
 * has not run out yet (`clock_timestamp()`, never `now()` — see below).
 *
 * WHY THIS IS A SEPARATE STATEMENT FROM `LOCK_ROW_SQL`, AND MUST STAY ONE:
 * under READ COMMITTED a statement's snapshot is taken when the statement
 * *starts*, and waiting for a row lock does NOT refresh it. Postgres only
 * re-checks the locked rows themselves (EvalPlanQual); the docs are explicit
 * that such a command "does not see effects of those commands on other rows in
 * the database". Had the `occupied` flag been computed in the same statement
 * that takes the lock, a transaction that queued behind a rival would have read
 * `reservation_seats` from its pre-wait snapshot and concluded the seats were
 * free — precisely the double-hold this lock exists to prevent. Issuing the
 * occupancy read as a *new* statement, after the lock is held, gives it a fresh
 * snapshot that necessarily includes everything the rival committed.
 *
 * Returns every seat of the row, ordered — never a filtered subset. See the
 * note on `findTrappedSeat` in `reserve()`.
 */
const OCCUPANCY_SQL = `
  SELECT s.id, s.seat_number,
         EXISTS (SELECT 1 FROM reservation_seats rs
                 JOIN reservations r ON r.id = rs.reservation_id
                 WHERE rs.seat_id = s.id
                   AND (r.status = 'booked'
                        OR (r.status = 'held' AND r.expires_at > clock_timestamp()))
         ) AS occupied
  FROM seats s
  WHERE s.instance_id = $1 AND s.row_number = $2
  ORDER BY s.seat_number
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validates the raw request shape and collapses duplicate seat ids. Runs before
 * anything touches the database, so a malformed request never opens a
 * transaction and never reaches SQL.
 */
function normaliseSeatIds(instanceId: number, seatIds: number[]): number[] {
  if (!isPositiveInt(instanceId)) {
    throw new DomainError('INVALID_INPUT', 400, 'instanceId must be a positive integer');
  }
  if (!Array.isArray(seatIds)) {
    throw new DomainError('INVALID_INPUT', 400, 'seatIds must be an array');
  }
  for (const seatId of seatIds) {
    if (!isPositiveInt(seatId)) {
      throw new DomainError('INVALID_INPUT', 400, 'Every seat id must be a positive integer');
    }
  }
  // A repeated id is a client slip, not an attack: dedupe rather than reject,
  // otherwise `isConsecutive` (which rejects duplicates) would report the far
  // less helpful NOT_CONSECUTIVE.
  const unique = [...new Set(seatIds)];
  if (unique.length === 0) {
    throw new DomainError('INVALID_INPUT', 400, 'At least one seat is required');
  }
  return unique;
}

/**
 * Creates a `held` reservation over `seatIds` for `userId`.
 *
 * Shape of the operation:
 *  1. pure/cheap validation and the two geometric rules (same row, consecutive)
 *     run BEFORE `BEGIN` — they cannot change under concurrency, so failing
 *     them early avoids opening a transaction and taking locks;
 *  2. everything that depends on live state (one-group-per-user, availability,
 *     Rule 2) runs inside the transaction, behind the whole-row lock.
 *
 * Every expiry comparison and the `expires_at` computation use
 * `clock_timestamp()`. `now()` is frozen at transaction start, so a transaction
 * that sat waiting on the row lock would compare fresh rows against a stale
 * clock.
 */
export async function reserve(
  userId: number,
  instanceId: number,
  seatIds: number[],
): Promise<ReservationResult> {
  if (!isPositiveInt(userId)) {
    throw new DomainError('INVALID_INPUT', 400, 'userId must be a positive integer');
  }
  const wanted = normaliseSeatIds(instanceId, seatIds);

  // --- pre-lock, lock-free geometry -----------------------------------------
  // Seats are immutable rows (pure layout), so reading them outside the lock is
  // safe: nothing concurrent can move a seat to another row.
  const found = await pool.query<SeatRow>(
    `SELECT id, row_number, seat_number
     FROM seats
     WHERE id = ANY($1::int[]) AND instance_id = $2`,
    [wanted, instanceId],
  );
  if (found.rows.length !== wanted.length) {
    // Unknown id, or an id belonging to a different instance. Same answer for
    // both: from the caller's point of view the seat is not there.
    throw new DomainError('NOT_FOUND', 404, 'One or more seats do not exist in this instance');
  }

  const rowNumber = found.rows[0].row_number;
  if (found.rows.some((seat) => seat.row_number !== rowNumber)) {
    throw new DomainError('DIFFERENT_ROWS', 400, 'All seats must be in the same row');
  }
  if (!isConsecutive(found.rows.map((seat) => seat.seat_number))) {
    throw new DomainError('NOT_CONSECUTIVE', 400, 'Seats must be consecutive');
  }

  const selectedIds = new Set(wanted);
  const orderedSeatIds = [...found.rows]
    .sort((a, b) => a.seat_number - b.seat_number)
    .map((seat) => seat.id);

  // --- transaction ----------------------------------------------------------
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');

    // Serialize this user's concurrent attempts on this instance. Without it
    // the one-group guard below is racy in exactly one way: two simultaneous
    // requests from the same user for seats in DIFFERENT rows lock disjoint
    // seat sets, so the row lock never brings them into contact and both pass
    // the guard. The advisory lock is transaction-scoped (released by COMMIT or
    // ROLLBACK, and by a dropped connection) and is taken BEFORE any seat lock.
    // Deadlock-free by construction: no transaction ever waits for this lock
    // while holding a seat lock, so it cannot be part of a wait cycle.
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [userId, instanceId]);

    // Fresh statement => fresh snapshot, taken after the advisory lock was
    // granted, so a rival request from the same user that just committed is
    // visible here.
    const active = await client.query(
      `SELECT 1
       FROM reservations
       WHERE user_id = $1 AND instance_id = $2 AND status = 'held'
         AND expires_at > clock_timestamp()
       LIMIT 1`,
      [userId, instanceId],
    );
    // `rows.length`, not `rowCount`: the latter is typed nullable by @types/pg.
    if (active.rows.length > 0) {
      throw new DomainError(
        'ACTIVE_GROUP_EXISTS',
        409,
        'You already hold seats in this instance; release them first',
      );
    }

    await client.query(LOCK_ROW_SQL, [instanceId, rowNumber]);
    const occupancy = await client.query<OccupancyRow>(OCCUPANCY_SQL, [instanceId, rowNumber]);

    // Defensive: the row cannot lose seats under us (layout is static), but if
    // it ever did, silently validating against a short row would corrupt the
    // gap arithmetic below.
    const lockedIds = new Set(occupancy.rows.map((seat) => seat.id));
    if (wanted.some((seatId) => !lockedIds.has(seatId))) {
      throw new DomainError('NOT_FOUND', 404, 'One or more seats do not exist in this instance');
    }

    if (occupancy.rows.some((seat) => selectedIds.has(seat.id) && seat.occupied)) {
      throw new DomainError('SEAT_TAKEN', 409, 'One or more seats are no longer available');
    }

    // `findTrappedSeat` measures gaps by ARRAY INDEX, not by seat number, so it
    // must be handed the complete, gapless, sorted occupancy of the row.
    // `OCCUPANCY_SQL` returns exactly that (every seat of the row, ORDER BY
    // seat_number) and nothing here filters it — only the `occupied` flag is
    // overlaid with this request's selection.
    const occupiedAfter = occupancy.rows.map((seat) => ({
      seatNumber: seat.seat_number,
      occupied: seat.occupied || selectedIds.has(seat.id),
    }));
    const trapped = findTrappedSeat(occupiedAfter);
    if (trapped !== null) {
      throw new DomainError(
        'TRAPPED_SEAT',
        400,
        `This selection would leave seat ${trapped} stranded on its own`,
      );
    }

    const created = await client.query<{ id: number; expires_at: Date | string }>(
      `INSERT INTO reservations (user_id, instance_id, status, expires_at)
       VALUES ($1, $2, 'held', clock_timestamp() + ($3 || ' minutes')::interval)
       RETURNING id, expires_at`,
      [userId, instanceId, String(config.holdMinutes)],
    );
    const reservationId = created.rows[0].id;

    await client.query(
      `INSERT INTO reservation_seats (reservation_id, seat_id)
       SELECT $1, unnest($2::int[])`,
      [reservationId, orderedSeatIds],
    );

    await notifySeatChanges(client, instanceId, reservationId);

    await client.query('COMMIT');

    return {
      reservationId,
      expiresAt: toIso(created.rows[0].expires_at),
      seatIds: orderedSeatIds,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is in an unknown state (the original error may well be
      // "connection lost"). Destroy it instead of handing it back poisoned, and
      // remember that, so `finally` does not release a second time.
      console.error('ROLLBACK failed', rollbackErr);
      client.release(true);
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}
