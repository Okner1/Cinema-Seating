import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { Client } from 'pg';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { getSnapshot } from '../src/realtime/snapshot.js';
import type { SeatView } from '../src/realtime/snapshot.js';
import { DomainError, bookReservation, reserve } from '../src/reservations/service.js';

const app = createApp();

/**
 * Mirror of the service's row-lock statement. The test needs to take exactly the
 * lock `bookReservation` will queue behind, from a connection the test controls,
 * so the wait can be held open while the world changes underneath the waiter.
 * It is duplicated rather than imported on purpose: the service does not export
 * it, and a test that reached into the module's internals would stop being a
 * black-box description of the contract.
 */
const LOCK_ROW_SQL = `
  SELECT s.id
  FROM seats s
  WHERE s.instance_id = $1 AND s.row_number = $2
  ORDER BY s.seat_number
  FOR UPDATE OF s
`;

/** How long the contested hold has left when the blocked book starts waiting. */
const FUSE_MS = 400;
/** How long the rival transaction keeps the seat locks — comfortably past the fuse. */
const LOCK_HOLD_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mainHallId(): Promise<number> {
  const found = await pool.query<{ id: number }>(`SELECT id FROM map_instances WHERE name = $1`, [
    'Main Hall',
  ]);
  return found.rows[0].id;
}

/** Ids of the given seat numbers in one row, in the order asked for. */
async function seatIds(instanceId: number, row: number, numbers: number[]): Promise<number[]> {
  const found = await pool.query<{ id: number; seat_number: number }>(
    `SELECT id, seat_number FROM seats
     WHERE instance_id = $1 AND row_number = $2 AND seat_number = ANY($3::int[])`,
    [instanceId, row, numbers],
  );
  expect(found.rows).toHaveLength(numbers.length);
  return numbers.map((n) => found.rows.find((s) => s.seat_number === n)!.id);
}

async function createUser(username: string): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
    [username, 'not-a-real-hash'],
  );
  return inserted.rows[0].id;
}

/** Registers a user and keeps both halves of its identity: cookie and id. */
async function register(username: string): Promise<{ userId: number; cookie: string[] }> {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'Passw0rd' });
  expect(registered.status).toBe(201);
  return {
    userId: registered.body.id as number,
    cookie: registered.headers['set-cookie'] as unknown as string[],
  };
}

async function statusOf(reservationId: number): Promise<string> {
  const found = await pool.query<{ status: string }>(
    `SELECT status FROM reservations WHERE id = $1`,
    [reservationId],
  );
  return found.rows[0].status;
}

/** Drags a hold's expiry into the past, the way the wall clock eventually would. */
async function expire(reservationId: number): Promise<void> {
  await pool.query(
    `UPDATE reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
    [reservationId],
  );
}

function seatAt(snapshot: SeatView[], row: number, number: number): SeatView {
  const found = snapshot.find((s) => s.row === row && s.number === number);
  expect(found).toBeDefined();
  return found as SeatView;
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

/**
 * Captures an outcome without ever leaving a rejection unhandled. The race tests
 * start a promise, then keep working for a second or more before looking at it;
 * an unobserved rejection in that window would surface as a process-level
 * warning (and, under some runners, kill the run) rather than as a test failure.
 */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (reason: unknown): Settled<T> => ({ ok: false, reason }),
  );
}

/** Asserts a captured outcome is a DomainError carrying `code`. */
function expectDomainFailure(outcome: Settled<unknown>, code: string): DomainError {
  expect(
    outcome.ok,
    `expected a DomainError ${code}, got a resolved value: ${JSON.stringify(
      outcome.ok ? outcome.value : undefined,
    )}`,
  ).toBe(false);
  const reason: unknown = outcome.ok ? undefined : outcome.reason;
  expect(reason).toBeInstanceOf(DomainError);
  const domain = reason as DomainError;
  expect(domain.code).toBe(code);
  return domain;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query('TRUNCATE users, reservations, reservation_seats RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('booking a held group', () => {
  it('flips the hold to booked over POST and through the service, and the snapshot agrees', async () => {
    const instanceId = await mainHallId();
    const viaRoute = await register('book-router');
    const viaService = await createUser('book-caller');

    const routeSeats = await seatIds(instanceId, 1, [3, 4]);
    const serviceSeats = await seatIds(instanceId, 2, [3, 4]);
    const routeHeld = await reserve(viaRoute.userId, instanceId, routeSeats);
    const serviceHeld = await reserve(viaService, instanceId, serviceSeats);

    const res = await request(app)
      .post(`/api/reservations/${routeHeld.reservationId}/book`)
      .set('Cookie', viaRoute.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reservationId: routeHeld.reservationId, status: 'booked' });

    // The service call is the same operation without the HTTP layer.
    await expect(bookReservation(viaService, serviceHeld.reservationId)).resolves.toEqual({
      reservationId: serviceHeld.reservationId,
      status: 'booked',
    });

    expect(await statusOf(routeHeld.reservationId)).toBe('booked');
    expect(await statusOf(serviceHeld.reservationId)).toBe('booked');

    // A booking is permanent occupancy: the snapshot must say `booked`, not
    // `reserved`, and must keep naming the owner.
    const snapshot = await getSnapshot(instanceId);
    for (const [row, number, userId] of [
      [1, 3, viaRoute.userId],
      [1, 4, viaRoute.userId],
      [2, 3, viaService],
      [2, 4, viaService],
    ] as const) {
      const seat = seatAt(snapshot, row, number);
      expect(seat.status).toBe('booked');
      expect(seat.userId).toBe(userId);
    }
  });

  it('answers 410 once the hold has lapsed, and leaves the seats free', async () => {
    const instanceId = await mainHallId();
    const owner = await register('book-latecomer');
    const ids = await seatIds(instanceId, 3, [3, 4]);
    const held = await reserve(owner.userId, instanceId, ids);

    await expire(held.reservationId);

    const res = await request(app)
      .post(`/api/reservations/${held.reservationId}/book`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: expect.any(String), code: 'EXPIRED' });

    // A lapsed hold cannot be resurrected into a booking.
    expect(await statusOf(held.reservationId)).not.toBe('booked');
    const snapshot = await getSnapshot(instanceId);
    expect(seatAt(snapshot, 3, 3).status).toBe('available');
    expect(seatAt(snapshot, 3, 4).status).toBe('available');
  });

  it('is idempotent: a double-click books once and answers 200 twice', async () => {
    const instanceId = await mainHallId();
    const owner = await register('book-doubleclicker');
    const ids = await seatIds(instanceId, 4, [3, 4]);
    const held = await reserve(owner.userId, instanceId, ids);

    const first = await request(app)
      .post(`/api/reservations/${held.reservationId}/book`)
      .set('Cookie', owner.cookie);
    const second = await request(app)
      .post(`/api/reservations/${held.reservationId}/book`)
      .set('Cookie', owner.cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ reservationId: held.reservationId, status: 'booked' });

    // Re-booking is a no-op, not a second purchase: one group, the same seats.
    const groups = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM reservations WHERE status = 'booked'`,
    );
    expect(Number(groups.rows[0].n)).toBe(1);
    const junction = await pool.query<{ seat_id: number }>(
      `SELECT seat_id FROM reservation_seats WHERE reservation_id = $1 ORDER BY seat_id`,
      [held.reservationId],
    );
    expect(junction.rows.map((r) => r.seat_id)).toEqual([...ids].sort((a, b) => a - b));
  });

  it('answers 403 to anyone but the owner', async () => {
    const instanceId = await mainHallId();
    const owner = await register('book-owner');
    const intruder = await register('book-intruder');
    const ids = await seatIds(instanceId, 5, [3, 4]);
    const held = await reserve(owner.userId, instanceId, ids);

    const res = await request(app)
      .post(`/api/reservations/${held.reservationId}/book`)
      .set('Cookie', intruder.cookie);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), code: 'FORBIDDEN' });
    expect(await statusOf(held.reservationId)).toBe('held');
  });
});

/**
 * The seats of an expired hold belong to whoever takes them next. Booking is the
 * one operation that could hand them back to the original holder anyway, because
 * it is the only one that turns a hold into a permanent claim — so it is the one
 * operation whose expiry check has to be right.
 */
describe('booking cannot claim an expired, re-reserved group', () => {
  it('refuses with EXPIRED after a rival has legitimately taken the seats', async () => {
    const instanceId = await mainHallId();
    const alice = await register('race-alice');
    const bob = await createUser('race-bob');
    const contested = await seatIds(instanceId, 6, [3, 4]);

    const aliceHeld = await reserve(alice.userId, instanceId, contested);
    await expire(aliceHeld.reservationId);

    // Lazy expiry: Bob's reserve() sees the seats as free and takes them. This
    // is the ordinary, correct outcome — it is what makes Alice's stale id
    // dangerous.
    const bobHeld = await reserve(bob, instanceId, contested);

    const res = await request(app)
      .post(`/api/reservations/${aliceHeld.reservationId}/book`)
      .set('Cookie', alice.cookie);

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: expect.any(String), code: 'EXPIRED' });

    expect(await statusOf(aliceHeld.reservationId)).not.toBe('booked');
    expect(await statusOf(bobHeld.reservationId)).toBe('held');

    // Bob's hold is untouched: the seats read as his, and as `reserved` — a
    // `booked` here would mean Alice's dead hold overwrote a live one.
    const snapshot = await getSnapshot(instanceId);
    for (const number of [3, 4]) {
      const seat = seatAt(snapshot, 6, number);
      expect(seat.status).toBe('reserved');
      expect(seat.userId).toBe(bob);
    }
  });

  /**
   * The same theft, but committed while the booking transaction is already open
   * and waiting — the case a transaction-start clock cannot see.
   *
   * A rival transaction holds the row's seat locks. Alice's book gets past the
   * reservation row (her hold is still live at that instant), then queues on the
   * seat locks. While it waits, her fuse burns out and Bob's hold is written and
   * committed by the lock holder. Under READ COMMITTED the waiter's next
   * statement takes a FRESH snapshot, so it sees Bob — but only if it also asks
   * the wall clock again. `now()` is frozen at BEGIN, which was before the fuse
   * blew, so an implementation using it would conclude the hold is still live
   * and book seats that are already Bob's. `clock_timestamp()`, read after the
   * lock is granted, is the only reading that reports the truth.
   */
  it('refuses with EXPIRED when the hold lapses while the book waits on the seat locks', async () => {
    const instanceId = await mainHallId();
    const alice = await register('lockwait-alice');
    const bob = await createUser('lockwait-bob');
    const contested = await seatIds(instanceId, 7, [3, 4]);

    const aliceHeld = await reserve(alice.userId, instanceId, contested);

    const rival = new Client({ connectionString: config.databaseUrl });
    await rival.connect();
    let booking: Promise<Settled<{ reservationId: number; status: 'booked' }>> | null = null;
    let bobReservationId: number | null = null;

    try {
      await rival.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // The rival is mid-reserve: it owns the row's seat locks and has not
      // decided anything yet.
      await rival.query(LOCK_ROW_SQL, [instanceId, 7]);

      // Arm the fuse only now, so the hold is unambiguously live when book opens
      // its transaction and reads the reservation row.
      await pool.query(
        `UPDATE reservations SET expires_at = clock_timestamp() + ($2 || ' milliseconds')::interval
         WHERE id = $1`,
        [aliceHeld.reservationId, String(FUSE_MS)],
      );

      // Fire and DO NOT await: this call blocks inside Postgres on the seat locks.
      booking = settle(bookReservation(alice.userId, aliceHeld.reservationId));

      // Outlast the fuse while still holding the locks.
      await sleep(LOCK_HOLD_MS);

      // The rival finishes what a reserve() would have done, as the legitimate
      // lazy-expiry winner, and commits — releasing the locks Alice waits on.
      const created = await rival.query<{ id: number }>(
        `INSERT INTO reservations (user_id, instance_id, status, expires_at)
         VALUES ($1, $2, 'held', clock_timestamp() + ($3 || ' minutes')::interval)
         RETURNING id`,
        [bob, instanceId, String(config.holdMinutes)],
      );
      bobReservationId = created.rows[0].id;
      await rival.query(
        `INSERT INTO reservation_seats (reservation_id, seat_id)
         SELECT $1::int, unnest($2::int[])`,
        [bobReservationId, contested],
      );
      await rival.query('COMMIT');
    } finally {
      // Never leave the locks (or the connection) behind, whatever failed above.
      await rival.query('ROLLBACK').catch(() => undefined);
      await rival.end().catch(() => undefined);
    }

    expect(booking).not.toBeNull();
    const outcome = await (booking as Promise<Settled<{ reservationId: number; status: 'booked' }>>);
    const failure = expectDomainFailure(outcome, 'EXPIRED');
    expect(failure.httpStatus).toBe(410);

    expect(await statusOf(aliceHeld.reservationId)).not.toBe('booked');
    expect(await statusOf(bobReservationId as number)).toBe('held');

    const snapshot = await getSnapshot(instanceId);
    for (const number of [3, 4]) {
      const seat = seatAt(snapshot, 7, number);
      expect(seat.status).toBe('reserved');
      expect(seat.userId).toBe(bob);
    }
  });
});
