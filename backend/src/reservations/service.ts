import type { ClientBase, PoolClient } from 'pg';
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

export interface BookingResult {
  reservationId: number;
  status: 'booked';
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
 * `$3` is a reservation to EXCLUDE from the calculation, or NULL for none.
 * `modifyReservation` re-validates a group against a world where its own seats
 * are free: counted as occupied, the group's current seats would make it
 * collide with itself, and no selection could ever be shrunk or slid sideways.
 *
 * Returns every seat of the row, ordered — never a filtered subset. See the
 * note on `findTrappedSeat` in `reserve()`.
 */
const OCCUPANCY_SQL = `
  SELECT s.id, s.seat_number,
         EXISTS (SELECT 1 FROM reservation_seats rs
                 JOIN reservations r ON r.id = rs.reservation_id
                 WHERE rs.seat_id = s.id
                   AND ($3::int IS NULL OR rs.reservation_id <> $3)
                   AND (r.status = 'booked'
                        OR (r.status = 'held' AND r.expires_at > clock_timestamp()))
         ) AS occupied
  FROM seats s
  WHERE s.instance_id = $1 AND s.row_number = $2
  ORDER BY s.seat_number
`;

/**
 * Resolves seat ids to their physical position. Seats are immutable rows (pure
 * layout), so this needs no lock: nothing concurrent can move a seat to another
 * row, and the answer is the same before or inside a transaction.
 */
const SEAT_LAYOUT_SQL = `
  SELECT id, row_number, seat_number
  FROM seats
  WHERE id = ANY($1::int[]) AND instance_id = $2
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
function normaliseSeatIds(seatIds: number[]): number[] {
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
 * Applies the two geometric rules — one row, no gaps — to a resolved selection,
 * and returns where it sits. Pure arithmetic over immutable layout, so it holds
 * whether it runs before `BEGIN` or between two locks.
 */
function assertGroupGeometry(
  found: SeatRow[],
  wanted: number[],
): { rowNumber: number; orderedSeatIds: number[] } {
  if (found.length !== wanted.length) {
    // Unknown id, or an id belonging to a different instance. Same answer for
    // both: from the caller's point of view the seat is not there.
    throw new DomainError('NOT_FOUND', 404, 'One or more seats do not exist in this instance');
  }
  const rowNumber = found[0].row_number;
  if (found.some((seat) => seat.row_number !== rowNumber)) {
    throw new DomainError('DIFFERENT_ROWS', 400, 'All seats must be in the same row');
  }
  if (!isConsecutive(found.map((seat) => seat.seat_number))) {
    throw new DomainError('NOT_CONSECUTIVE', 400, 'Seats must be consecutive');
  }
  const orderedSeatIds = [...found]
    .sort((a, b) => a.seat_number - b.seat_number)
    .map((seat) => seat.id);
  return { rowNumber, orderedSeatIds };
}

/**
 * The live-state rules, checked under the whole-row lock: every wanted seat is
 * still there, none of them is taken, and the row the selection would leave
 * behind strands nobody.
 *
 * `occupancy` MUST be the complete, sorted row as returned by `OCCUPANCY_SQL`:
 * `findTrappedSeat` measures gaps by ARRAY INDEX, not by seat number, so a
 * filtered array would silently close gaps that exist in reality. Nothing here
 * removes an entry — the selection is overlaid on the `occupied` flag instead.
 */
function assertSelectionAvailable(occupancy: OccupancyRow[], wanted: number[]): void {
  const selectedIds = new Set(wanted);

  // Defensive: the row cannot lose seats under us (layout is static), but if it
  // ever did, silently validating against a short row would corrupt the gap
  // arithmetic below.
  const lockedIds = new Set(occupancy.map((seat) => seat.id));
  if (wanted.some((seatId) => !lockedIds.has(seatId))) {
    throw new DomainError('NOT_FOUND', 404, 'One or more seats do not exist in this instance');
  }

  if (occupancy.some((seat) => selectedIds.has(seat.id) && seat.occupied)) {
    throw new DomainError('SEAT_TAKEN', 409, 'One or more seats are no longer available');
  }

  const occupiedAfter = occupancy.map((seat) => ({
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
}

/**
 * Runs `body` in one transaction on one pooled connection.
 *
 * The isolation level is pinned explicitly: the whole design leans on READ
 * COMMITTED's per-statement snapshots (see `OCCUPANCY_SQL`). A session default
 * of REPEATABLE READ would freeze the snapshot for the whole transaction and
 * silently bring the double-hold back.
 */
async function withTransaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is in an unknown state (the original error may well be
      // "connection lost"). Destroy it instead of handing it back poisoned, and
      // remember that, so `finally` does not release a second time.
      console.error('ROLLBACK failed', rollbackErr);
      // Flag first: if release() itself throws, `finally` must not release a
      // second time and mask the original error.
      released = true;
      client.release(true);
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

interface HeldReservation {
  instanceId: number;
  live: boolean;
}

/**
 * Takes the row lock on one reservation and answers the three ownership
 * questions every mutation asks. This is the FIRST lock of both
 * `modifyReservation` and `releaseReservation`, before any seat lock — the
 * order mandated for deadlock freedom.
 *
 * `live` (still inside its hold window) is reported rather than enforced:
 * modifying an expired hold is meaningless, releasing one is merely redundant.
 * The flag is computed above the lock in the plan, so `clock_timestamp()` is
 * read after the wait for the lock ends, never from a stale transaction clock.
 */
async function lockHeldReservation(
  client: PoolClient,
  userId: number,
  reservationId: number,
): Promise<HeldReservation> {
  const found = await client.query<{
    user_id: number;
    instance_id: number;
    status: string;
    live: boolean;
  }>(
    `SELECT user_id, instance_id, status, (expires_at > clock_timestamp()) AS live
     FROM reservations
     WHERE id = $1
     FOR UPDATE`,
    [reservationId],
  );
  if (found.rows.length === 0) {
    throw new DomainError('NOT_FOUND', 404, 'Reservation not found');
  }
  const reservation = found.rows[0];
  if (reservation.user_id !== userId) {
    // Deliberately distinct from NOT_FOUND: the id came from this user's own
    // client, so there is nothing to hide by pretending it does not exist.
    throw new DomainError('FORBIDDEN', 403, 'This reservation belongs to another user');
  }
  if (reservation.status !== 'held') {
    throw new DomainError('EXPIRED', 410, 'This reservation is no longer held');
  }
  return { instanceId: reservation.instance_id, live: reservation.live };
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
  if (!isPositiveInt(instanceId)) {
    throw new DomainError('INVALID_INPUT', 400, 'instanceId must be a positive integer');
  }
  const wanted = normaliseSeatIds(seatIds);

  // --- pre-lock, lock-free geometry -----------------------------------------
  const found = await pool.query<SeatRow>(SEAT_LAYOUT_SQL, [wanted, instanceId]);
  const { rowNumber, orderedSeatIds } = assertGroupGeometry(found.rows, wanted);

  // --- transaction ----------------------------------------------------------
  return withTransaction(async (client) => {
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
    const occupancy = await client.query<OccupancyRow>(OCCUPANCY_SQL, [
      instanceId,
      rowNumber,
      null,
    ]);
    assertSelectionAvailable(occupancy.rows, wanted);

    const created = await client.query<{ id: number; expires_at: Date | string }>(
      `INSERT INTO reservations (user_id, instance_id, status, expires_at)
       VALUES ($1, $2, 'held', clock_timestamp() + ($3 || ' minutes')::interval)
       RETURNING id, expires_at`,
      [userId, instanceId, String(config.holdMinutes)],
    );
    const reservationId = created.rows[0].id;

    await client.query(
      `INSERT INTO reservation_seats (reservation_id, seat_id)
       SELECT $1::int, unnest($2::int[])`,
      [reservationId, orderedSeatIds],
    );

    await notifySeatChanges(client, instanceId, reservationId);

    return {
      reservationId,
      expiresAt: toIso(created.rows[0].expires_at),
      seatIds: orderedSeatIds,
    };
  });
}

/**
 * Replaces the seats of an existing `held` group with `seatIds` — the COMPLETE
 * desired selection, not a delta. Emptying a group is `releaseReservation`, not
 * a modification, so an empty set is `INVALID_INPUT`.
 *
 * LOCK ORDER — the reservation row first, its seat row second. `reserve` takes
 * an advisory lock first and no reservation row lock; this function takes no
 * advisory lock at all. The two orders therefore never cross, so no wait cycle
 * can form. Skipping the advisory lock is safe here because the one-group rule
 * is about *creating* a second group: this reservation already exists, and the
 * `FOR UPDATE` on its row serialises concurrent edits of it by itself.
 */
export async function modifyReservation(
  userId: number,
  reservationId: number,
  seatIds: number[],
): Promise<ReservationResult> {
  if (!isPositiveInt(userId)) {
    throw new DomainError('INVALID_INPUT', 400, 'userId must be a positive integer');
  }
  if (!isPositiveInt(reservationId)) {
    throw new DomainError('INVALID_INPUT', 400, 'reservationId must be a positive integer');
  }
  const wanted = normaliseSeatIds(seatIds);

  return withTransaction(async (client) => {
    const { instanceId, live } = await lockHeldReservation(client, userId, reservationId);
    if (!live) {
      throw new DomainError('EXPIRED', 410, 'This hold has expired');
    }

    // Where the group sits today. A modification stays inside its own row: the
    // group is one physical block, and landing it in another row is a different
    // reservation, not an edit of this one.
    const current = await client.query<{ row_number: number }>(
      `SELECT s.row_number
       FROM reservation_seats rs
       JOIN seats s ON s.id = rs.seat_id
       WHERE rs.reservation_id = $1
       LIMIT 1`,
      [reservationId],
    );
    if (current.rows.length === 0) {
      throw new DomainError('NOT_FOUND', 404, 'This reservation holds no seats');
    }
    const currentRow = current.rows[0].row_number;

    const found = await client.query<SeatRow>(SEAT_LAYOUT_SQL, [wanted, instanceId]);
    const { rowNumber, orderedSeatIds } = assertGroupGeometry(found.rows, wanted);
    if (rowNumber !== currentRow) {
      throw new DomainError('DIFFERENT_ROWS', 400, 'A group can only be changed within its own row');
    }

    await client.query(LOCK_ROW_SQL, [instanceId, rowNumber]);
    // Excluding this reservation makes its current seats read as free, which is
    // what re-validation needs: the group must be judged against the row as it
    // would look *without* it, not against its own footprint.
    const occupancy = await client.query<OccupancyRow>(OCCUPANCY_SQL, [
      instanceId,
      rowNumber,
      reservationId,
    ]);
    assertSelectionAvailable(occupancy.rows, wanted);

    // Replace wholesale rather than diff: `seatIds` is the full desired set, and
    // both statements run under the same row lock, so no reader can observe the
    // gap between them.
    await client.query(`DELETE FROM reservation_seats WHERE reservation_id = $1`, [reservationId]);
    await client.query(
      `INSERT INTO reservation_seats (reservation_id, seat_id)
       SELECT $1::int, unnest($2::int[])`,
      [reservationId, orderedSeatIds],
    );

    // A modification RESTARTS the hold window instead of inheriting what is left
    // of it: the user is demonstrably still working on this group.
    const updated = await client.query<{ expires_at: Date | string }>(
      `UPDATE reservations
       SET expires_at = clock_timestamp() + ($2 || ' minutes')::interval
       WHERE id = $1
       RETURNING expires_at`,
      [reservationId, String(config.holdMinutes)],
    );

    await notifySeatChanges(client, instanceId, reservationId);

    return {
      reservationId,
      expiresAt: toIso(updated.rows[0].expires_at),
      seatIds: orderedSeatIds,
    };
  });
}

/**
 * Turns a `held` group into a `booked` one. Terminal in the other direction: a
 * booked group never expires, so `expires_at` stops meaning anything for it and
 * `OCCUPANCY_SQL` counts it as occupied unconditionally.
 *
 * LOCK ORDER (mandated, and the whole reason this function is not three lines):
 *
 *  1. the reservation row `FOR UPDATE` — owner and status;
 *  2. THEN the group's physical row, via the very same `LOCK_ROW_SQL` a reserve
 *     takes. THESE SEAT LOCKS ARE LOAD-BEARING. A book that locked only its own
 *     reservation row would share no lock with a concurrent `reserve`, which
 *     locks only seats: the two would interleave freely, and a book could
 *     confirm a hold that had already lapsed and whose seats the rival had
 *     lawfully taken as the lazy-expiry winner. Taking the row's seats puts both
 *     operations on the same queue, so exactly one of them decides the row;
 *  3. THEN — and only then — the expiry decision.
 *
 * Step 3 re-reads the clock in a STATEMENT OF ITS OWN. Reusing a `live` flag
 * computed alongside the step-1 lock (what `lockHeldReservation` returns, which
 * is why this function does not use it) would compare against a clock read
 * *before* the wait on the seat locks: under contention that wait is exactly
 * where a hold runs out. `clock_timestamp()` re-reads the wall clock on every
 * call; `now()` is frozen at `BEGIN` and would be stale from the first
 * statement onwards.
 *
 * Re-booking an already-`booked` group of one's own succeeds silently. A double
 * click is not an error, and reporting one would leave the user staring at a
 * failure on seats they own.
 */
export async function bookReservation(
  userId: number,
  reservationId: number,
): Promise<BookingResult> {
  if (!isPositiveInt(userId)) {
    throw new DomainError('INVALID_INPUT', 400, 'userId must be a positive integer');
  }
  if (!isPositiveInt(reservationId)) {
    throw new DomainError('INVALID_INPUT', 400, 'reservationId must be a positive integer');
  }

  return withTransaction(async (client) => {
    // --- (1) the reservation row ---------------------------------------------
    // Inlined rather than delegated to `lockHeldReservation`: that helper both
    // rejects every non-`held` status (closing the idempotent path below) and
    // hands back a pre-seat-lock `live` flag this function must not use.
    const found = await client.query<{ user_id: number; instance_id: number; status: string }>(
      `SELECT user_id, instance_id, status
       FROM reservations
       WHERE id = $1
       FOR UPDATE`,
      [reservationId],
    );
    if (found.rows.length === 0) {
      throw new DomainError('NOT_FOUND', 404, 'Reservation not found');
    }
    const reservation = found.rows[0];
    if (reservation.user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'This reservation belongs to another user');
    }
    if (reservation.status === 'booked') {
      // Already ours and already confirmed: nothing to change, nothing to
      // announce. Same answer as the first click.
      return { reservationId, status: 'booked' as const };
    }
    if (reservation.status !== 'held') {
      throw new DomainError('EXPIRED', 410, 'This reservation is no longer held');
    }
    const instanceId = reservation.instance_id;

    // --- (2) the group's seats ------------------------------------------------
    const current = await client.query<{ row_number: number }>(
      `SELECT s.row_number
       FROM reservation_seats rs
       JOIN seats s ON s.id = rs.seat_id
       WHERE rs.reservation_id = $1
       LIMIT 1`,
      [reservationId],
    );
    if (current.rows.length === 0) {
      throw new DomainError('NOT_FOUND', 404, 'This reservation holds no seats');
    }
    await client.query(LOCK_ROW_SQL, [instanceId, current.rows[0].row_number]);

    // --- (3) the expiry decision, on a clock read after the wait --------------
    const fresh = await client.query<{ live: boolean }>(
      `SELECT (expires_at > clock_timestamp()) AS live FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (!fresh.rows[0].live) {
      throw new DomainError('EXPIRED', 410, 'This hold has expired');
    }

    // --- (4) confirm ----------------------------------------------------------
    await client.query(`UPDATE reservations SET status = 'booked' WHERE id = $1`, [reservationId]);

    await notifySeatChanges(client, instanceId, reservationId);

    return { reservationId, status: 'booked' as const };
  });
}

/**
 * Gives up a `held` group. Terminal: a released reservation is never revived,
 * the user simply reserves again.
 *
 * No seat lock is taken — releasing only ever *frees* seats, so it can neither
 * double-book anything nor strand a neighbour (Rule 2 constrains selections, not
 * cancellations). An expired-but-still-`held` row is released rather than
 * refused: the seats were already free by then, and telling the user their
 * cancel failed would be absurd.
 */
export async function releaseReservation(userId: number, reservationId: number): Promise<void> {
  if (!isPositiveInt(userId)) {
    throw new DomainError('INVALID_INPUT', 400, 'userId must be a positive integer');
  }
  if (!isPositiveInt(reservationId)) {
    throw new DomainError('INVALID_INPUT', 400, 'reservationId must be a positive integer');
  }

  await withTransaction(async (client) => {
    const { instanceId } = await lockHeldReservation(client, userId, reservationId);

    await client.query(`UPDATE reservations SET status = 'released' WHERE id = $1`, [
      reservationId,
    ]);

    await notifySeatChanges(client, instanceId, reservationId);
  });
}
