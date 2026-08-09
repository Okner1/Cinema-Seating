import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { getSnapshot } from '../src/realtime/snapshot.js';
import type { SeatView } from '../src/realtime/snapshot.js';
import {
  DomainError,
  modifyReservation,
  releaseReservation,
  reserve,
} from '../src/reservations/service.js';

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

/** The seat ids currently attached to a reservation, ascending. */
async function junctionSeatIds(reservationId: number): Promise<number[]> {
  const found = await pool.query<{ seat_id: number }>(
    `SELECT seat_id FROM reservation_seats WHERE reservation_id = $1 ORDER BY seat_id`,
    [reservationId],
  );
  return found.rows.map((r) => r.seat_id);
}

/** The persisted expiry, normalised the same way the service reports it. */
async function storedExpiry(reservationId: number): Promise<string> {
  const found = await pool.query<{ expires_at: Date | string }>(
    `SELECT expires_at FROM reservations WHERE id = $1`,
    [reservationId],
  );
  const value = found.rows[0].expires_at;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function statusOf(reservationId: number): Promise<string> {
  const found = await pool.query<{ status: string }>(
    `SELECT status FROM reservations WHERE id = $1`,
    [reservationId],
  );
  return found.rows[0].status;
}

function ascending(ids: number[]): number[] {
  return [...ids].sort((a, b) => a - b);
}

function seatAt(snapshot: SeatView[], row: number, number: number): SeatView {
  const found = snapshot.find((s) => s.row === row && s.number === number);
  expect(found).toBeDefined();
  return found as SeatView;
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

describe('modifying a held group', () => {
  it('extends {3,4} to {3,4,5} over PATCH and restarts the hold clock', async () => {
    const instanceId = await mainHallId();
    const owner = await register('modify-extender');
    const initial = await seatIds(instanceId, 1, [3, 4]);
    const extended = await seatIds(instanceId, 1, [3, 4, 5]);

    const held = await reserve(owner.userId, instanceId, initial);

    // Pull the expiry well inside the hold window before modifying. A reset is
    // then a jump of minutes rather than of milliseconds, so "the clock
    // restarted" is decidable without racing the database clock.
    await pool.query(
      `UPDATE reservations SET expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1`,
      [held.reservationId],
    );
    const before = new Date(await storedExpiry(held.reservationId)).getTime();

    const res = await request(app)
      .patch(`/api/reservations/${held.reservationId}/seats`)
      .set('Cookie', owner.cookie)
      .send({ seatIds: extended });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reservationId: held.reservationId,
      expiresAt: expect.stringMatching(ISO_UTC),
      seatIds: extended,
    });

    // The group grew in place: same reservation row, three seats attached.
    expect(await junctionSeatIds(held.reservationId)).toEqual(ascending(extended));
    expect(await statusOf(held.reservationId)).toBe('held');

    const after = new Date(res.body.expiresAt as string).getTime();
    expect(after).toBeGreaterThan(before);
    // ...and the new expiry is a fresh full hold, not merely a nudge.
    expect(after).toBeGreaterThan(Date.now() + config.holdMinutes * 60_000 - 60_000);
    // The reported expiry is the stored one, so the reset was persisted.
    expect(await storedExpiry(held.reservationId)).toBe(res.body.expiresAt);
  });

  it('shrinks {3,4,5} to {3,4}, dropping the seat left out of the desired set', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('modify-shrinker');
    const initial = await seatIds(instanceId, 2, [3, 4, 5]);
    const shrunk = await seatIds(instanceId, 2, [3, 4]);

    const held = await reserve(userId, instanceId, initial);
    const result = await modifyReservation(userId, held.reservationId, shrunk);

    expect(result.reservationId).toBe(held.reservationId);
    expect(result.seatIds).toEqual(shrunk);
    expect(result.expiresAt).toMatch(ISO_UTC);
    expect(await junctionSeatIds(held.reservationId)).toEqual(ascending(shrunk));

    // The released seat is free again for everybody else.
    const snapshot = await getSnapshot(instanceId);
    expect(seatAt(snapshot, 2, 5).status).toBe('available');
    expect(seatAt(snapshot, 2, 4).status).toBe('reserved');
  });

  it('refuses a desired set that does not sit in the row the group already occupies', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('modify-rowhopper');
    const initial = await seatIds(instanceId, 4, [3, 4]);
    const held = await reserve(userId, instanceId, initial);

    // A perfectly legal pair — in the wrong row. A group cannot teleport.
    const elsewhere = await seatIds(instanceId, 5, [3, 4]);
    const moved = await expectDomainError(
      modifyReservation(userId, held.reservationId, elsewhere),
      'DIFFERENT_ROWS',
    );
    expect(moved.httpStatus).toBe(400);

    // A desired set straddling two rows is the same failure.
    const straddling = [
      ...(await seatIds(instanceId, 4, [3])),
      ...(await seatIds(instanceId, 5, [3])),
    ];
    await expectDomainError(
      modifyReservation(userId, held.reservationId, straddling),
      'DIFFERENT_ROWS',
    );

    // Neither attempt may have touched the group.
    expect(await junctionSeatIds(held.reservationId)).toEqual(ascending(initial));
  });

  it('answers 410 once the hold has lapsed', async () => {
    const instanceId = await mainHallId();
    const owner = await register('modify-latecomer');
    const initial = await seatIds(instanceId, 3, [3, 4]);
    const held = await reserve(owner.userId, instanceId, initial);

    await pool.query(
      `UPDATE reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [held.reservationId],
    );

    const res = await request(app)
      .patch(`/api/reservations/${held.reservationId}/seats`)
      .set('Cookie', owner.cookie)
      .send({ seatIds: await seatIds(instanceId, 3, [3, 4, 5]) });

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: expect.any(String), code: 'EXPIRED' });
    // A lapsed hold cannot be revived by editing it.
    expect(await junctionSeatIds(held.reservationId)).toEqual(ascending(initial));
  });

  it('answers 403 to anyone but the owner, on both PATCH and DELETE', async () => {
    const instanceId = await mainHallId();
    const owner = await register('modify-owner');
    const intruder = await register('modify-intruder');
    const initial = await seatIds(instanceId, 8, [3, 4]);
    const held = await reserve(owner.userId, instanceId, initial);

    const patched = await request(app)
      .patch(`/api/reservations/${held.reservationId}/seats`)
      .set('Cookie', intruder.cookie)
      .send({ seatIds: await seatIds(instanceId, 8, [3, 4, 5]) });

    expect(patched.status).toBe(403);
    expect(patched.body).toEqual({ error: expect.any(String), code: 'FORBIDDEN' });

    const deleted = await request(app)
      .delete(`/api/reservations/${held.reservationId}`)
      .set('Cookie', intruder.cookie);

    expect(deleted.status).toBe(403);
    expect(deleted.body).toEqual({ error: expect.any(String), code: 'FORBIDDEN' });

    // The owner's group is untouched by either attempt.
    expect(await statusOf(held.reservationId)).toBe('held');
    expect(await junctionSeatIds(held.reservationId)).toEqual(ascending(initial));
  });
});

describe('releasing a held group', () => {
  it('flips the status to released and frees the seats in the snapshot', async () => {
    const instanceId = await mainHallId();
    const viaRoute = await register('release-router');
    const viaService = await createUser('release-caller');

    const routeHeld = await reserve(viaRoute.userId, instanceId, await seatIds(instanceId, 6, [1, 2]));
    const serviceHeld = await reserve(viaService, instanceId, await seatIds(instanceId, 7, [1, 2]));

    const res = await request(app)
      .delete(`/api/reservations/${routeHeld.reservationId}`)
      .set('Cookie', viaRoute.cookie);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    // The service call is the same operation without the HTTP layer.
    await expect(releaseReservation(viaService, serviceHeld.reservationId)).resolves.toBeUndefined();

    expect(await statusOf(routeHeld.reservationId)).toBe('released');
    expect(await statusOf(serviceHeld.reservationId)).toBe('released');

    const snapshot = await getSnapshot(instanceId);
    for (const [row, number] of [
      [6, 1],
      [6, 2],
      [7, 1],
      [7, 2],
    ] as const) {
      const seat = seatAt(snapshot, row, number);
      expect(seat.status).toBe('available');
      expect(seat.userId).toBeNull();
      expect(seat.expiresAt).toBeNull();
    }
  });
});
