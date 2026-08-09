import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { DomainError, reserve } from '../src/reservations/service.js';

const app = createApp();

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

/** Reservation created straight through SQL, so its expiry can be in the past. */
async function seedReservation(
  userId: number,
  instanceId: number,
  status: string,
  minutes: number,
  ids: number[],
): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO reservations (user_id, instance_id, status, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + ($4 || ' minutes')::interval)
     RETURNING id`,
    [userId, instanceId, status, String(minutes)],
  );
  const reservationId = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO reservation_seats (reservation_id, seat_id) SELECT $1, unnest($2::int[])`,
    [reservationId, ids],
  );
  return reservationId;
}

/** Awaits `promise`, asserting it rejects with a DomainError carrying `code`. */
async function expectDomainError(promise: Promise<unknown>, code: string): Promise<DomainError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a DomainError ${code}, got no rejection`).toBeInstanceOf(DomainError);
  const domain = caught as DomainError;
  expect(domain.code).toBe(code);
  expect(typeof domain.message).toBe('string');
  expect(domain.message.length).toBeGreaterThan(0);
  return domain;
}

async function heldCount(): Promise<number> {
  const found = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM reservations WHERE status = 'held'`,
  );
  return Number(found.rows[0].n);
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

describe('reserve()', () => {
  it('holds the seats, returns an expiry ~holdMinutes out, and writes the junction rows', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('reserve-happy');
    const ids = await seatIds(instanceId, 1, [3, 4]);

    const before = Date.now();
    const result = await reserve(userId, instanceId, ids);
    const after = Date.now();

    expect(result.reservationId).toEqual(expect.any(Number));
    expect(result.seatIds).toEqual(ids);
    expect(result.expiresAt).toMatch(ISO_UTC);

    const expiresAt = new Date(result.expiresAt).getTime();
    const holdMs = config.holdMinutes * 60_000;
    // Generous window: the expiry is computed by the database clock, so only
    // the order of magnitude is assertable, not the exact instant.
    expect(expiresAt).toBeGreaterThan(before + holdMs - 60_000);
    expect(expiresAt).toBeLessThan(after + holdMs + 60_000);

    const stored = await pool.query<{ user_id: number; instance_id: number; status: string }>(
      `SELECT user_id, instance_id, status FROM reservations WHERE id = $1`,
      [result.reservationId],
    );
    expect(stored.rows).toEqual([{ user_id: userId, instance_id: instanceId, status: 'held' }]);

    const junction = await pool.query<{ seat_id: number }>(
      `SELECT seat_id FROM reservation_seats WHERE reservation_id = $1 ORDER BY seat_id`,
      [result.reservationId],
    );
    expect(junction.rows.map((r) => r.seat_id).sort((a, b) => a - b)).toEqual(
      [...ids].sort((a, b) => a - b),
    );
  });

  it('rejects an empty, unknown, cross-instance or different-row selection before locking', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('reserve-input');

    await expectDomainError(reserve(userId, instanceId, []), 'INVALID_INPUT');
    await expectDomainError(reserve(userId, instanceId, [0]), 'INVALID_INPUT');
    await expectDomainError(reserve(userId, instanceId, [1.5]), 'INVALID_INPUT');

    // No seat carries this id (the layout is 115 seats).
    await expectDomainError(reserve(userId, instanceId, [999_999]), 'NOT_FOUND');

    // Real seats, wrong instance.
    const ids = await seatIds(instanceId, 1, [1, 2]);
    await expectDomainError(reserve(userId, instanceId + 1000, ids), 'NOT_FOUND');

    const acrossRows = [
      ...(await seatIds(instanceId, 1, [5])),
      ...(await seatIds(instanceId, 2, [5])),
    ];
    await expectDomainError(reserve(userId, instanceId, acrossRows), 'DIFFERENT_ROWS');

    // Nothing above may have written anything.
    expect(await heldCount()).toBe(0);
  });

  it('rejects a non-consecutive selection', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('reserve-gappy');
    const ids = await seatIds(instanceId, 3, [2, 4]);

    await expectDomainError(reserve(userId, instanceId, ids), 'NOT_CONSECUTIVE');
    expect(await heldCount()).toBe(0);
  });

  it('refuses seats under a live hold but re-lets seats whose hold has lapsed', async () => {
    const instanceId = await mainHallId();
    const holder = await createUser('reserve-holder');
    const rival = await createUser('reserve-rival');

    const live = await seatIds(instanceId, 4, [1, 2]);
    await seedReservation(holder, instanceId, 'held', 15, live);
    await expectDomainError(reserve(rival, instanceId, live), 'SEAT_TAKEN');

    // Booked seats are occupied forever, expiry or not.
    const booked = await seatIds(instanceId, 5, [1, 2]);
    await seedReservation(holder, instanceId, 'booked', -60, booked);
    await expectDomainError(reserve(rival, instanceId, booked), 'SEAT_TAKEN');

    // Lazy expiry: a lapsed hold does not occupy anything.
    const lapsed = await seatIds(instanceId, 6, [1, 2]);
    await seedReservation(holder, instanceId, 'held', -1, lapsed);
    const result = await reserve(rival, instanceId, lapsed);
    expect(result.seatIds).toEqual(lapsed);
  });

  it('refuses a selection that would strand a single seat', async () => {
    const instanceId = await mainHallId();
    const holder = await createUser('reserve-neighbour');
    const rival = await createUser('reserve-trapper');

    await seedReservation(holder, instanceId, 'held', 15, await seatIds(instanceId, 7, [1, 2]));

    // {4,5} leaves seat 3 alone between two occupied blocks.
    const trapping = await seatIds(instanceId, 7, [4, 5]);
    const err = await expectDomainError(reserve(rival, instanceId, trapping), 'TRAPPED_SEAT');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain('3');

    // The adjacent selection {3,4} is fine — proof that the rule, not the row,
    // is what rejected the previous attempt.
    const adjacent = await seatIds(instanceId, 7, [3, 4]);
    const ok = await reserve(rival, instanceId, adjacent);
    expect(ok.seatIds).toEqual(adjacent);
  });

  it('allows only one live held group per user per instance', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('reserve-greedy');

    const first = await reserve(userId, instanceId, await seatIds(instanceId, 8, [1, 2]));
    expect(first.reservationId).toEqual(expect.any(Number));

    await expectDomainError(
      reserve(userId, instanceId, await seatIds(instanceId, 9, [1, 2])),
      'ACTIVE_GROUP_EXISTS',
    );
    expect(await heldCount()).toBe(1);

    // Once the group is out of the way, the same user may hold again.
    await pool.query(`UPDATE reservations SET status = 'released' WHERE id = $1`, [
      first.reservationId,
    ]);
    const second = await reserve(userId, instanceId, await seatIds(instanceId, 9, [1, 2]));
    expect(second.reservationId).not.toBe(first.reservationId);
  });
});

describe('POST /api/reservations', () => {
  async function register(username: string): Promise<string[]> {
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ username, password: 'Passw0rd' });
    expect(registered.status).toBe(201);
    return registered.headers['set-cookie'] as unknown as string[];
  }

  it('returns 401 without a cookie', async () => {
    const res = await request(app).post('/api/reservations').send({ instanceId: 1, seatIds: [1] });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('creates the hold and answers 201 with {reservationId, expiresAt, seatIds}', async () => {
    const instanceId = await mainHallId();
    const cookie = await register('route-reserver');
    const ids = await seatIds(instanceId, 10, [4, 5]);

    const res = await request(app)
      .post('/api/reservations')
      .set('Cookie', cookie)
      .send({ instanceId, seatIds: ids });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      reservationId: expect.any(Number),
      expiresAt: expect.stringMatching(ISO_UTC),
      seatIds: ids,
    });
  });

  it('maps a domain failure onto its status and {error, code} envelope', async () => {
    const instanceId = await mainHallId();
    const holder = await createUser('route-holder');
    const cookie = await register('route-latecomer');
    const ids = await seatIds(instanceId, 11, [1, 2]);
    await seedReservation(holder, instanceId, 'held', 15, ids);

    const taken = await request(app)
      .post('/api/reservations')
      .set('Cookie', cookie)
      .send({ instanceId, seatIds: ids });

    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: expect.any(String), code: 'SEAT_TAKEN' });

    const malformed = await request(app)
      .post('/api/reservations')
      .set('Cookie', cookie)
      .send({ instanceId, seatIds: 'not-an-array' });

    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: expect.any(String), code: 'INVALID_INPUT' });
  });
});
