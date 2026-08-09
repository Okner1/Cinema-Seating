import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { getSnapshot } from '../src/realtime/snapshot.js';
import type { SeatView } from '../src/realtime/snapshot.js';

const app = createApp();

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function mainHallId(): Promise<number> {
  const found = await pool.query<{ id: number }>(`SELECT id FROM map_instances WHERE name = $1`, [
    'Main Hall',
  ]);
  return found.rows[0].id;
}

async function seatId(instanceId: number, row: number, number: number): Promise<number> {
  const found = await pool.query<{ id: number }>(
    `SELECT id FROM seats WHERE instance_id = $1 AND row_number = $2 AND seat_number = $3`,
    [instanceId, row, number],
  );
  return found.rows[0].id;
}

async function createUser(username: string): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
    [username, 'not-a-real-hash'],
  );
  return inserted.rows[0].id;
}

/** Creates a reservation over `seatIds` with an expiry `minutes` from now. */
async function createReservation(
  userId: number,
  instanceId: number,
  status: string,
  minutes: number,
  seatIds: number[],
): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO reservations (user_id, instance_id, status, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + ($4 || ' minutes')::interval)
     RETURNING id`,
    [userId, instanceId, status, String(minutes)],
  );
  const reservationId = inserted.rows[0].id;
  for (const id of seatIds) {
    await pool.query(`INSERT INTO reservation_seats (reservation_id, seat_id) VALUES ($1, $2)`, [
      reservationId,
      id,
    ]);
  }
  return reservationId;
}

function seatAt(snapshot: SeatView[], row: number, number: number): SeatView {
  const found = snapshot.find((s) => s.row === row && s.number === number);
  expect(found).toBeDefined();
  return found as SeatView;
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

describe('getSnapshot', () => {
  it('marks live holds reserved, ignores expired holds, and returns every seat', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('snapshot-holder');

    await createReservation(userId, instanceId, 'held', 15, [
      await seatId(instanceId, 1, 1),
      await seatId(instanceId, 1, 2),
    ]);
    // Already lapsed: lazy expiry must treat it as if it were gone.
    await createReservation(userId, instanceId, 'held', -1, [await seatId(instanceId, 2, 1)]);

    const snapshot = await getSnapshot(instanceId);

    expect(snapshot).toHaveLength(115);

    const held = seatAt(snapshot, 1, 1);
    expect(held.status).toBe('reserved');
    expect(held.userId).toBe(userId);
    expect(held.expiresAt).toMatch(ISO_UTC);
    expect(new Date(held.expiresAt as string).getTime()).toBeGreaterThan(Date.now());

    const heldNeighbour = seatAt(snapshot, 1, 2);
    expect(heldNeighbour.status).toBe('reserved');
    expect(heldNeighbour.userId).toBe(userId);

    const expired = seatAt(snapshot, 2, 1);
    expect(expired.status).toBe('available');
    expect(expired.userId).toBeNull();
    expect(expired.expiresAt).toBeNull();

    // Untouched seats stay available, and rows come back ordered.
    expect(seatAt(snapshot, 13, 5).status).toBe('available');
    expect(snapshot[0]).toMatchObject({ row: 1, number: 1 });
    expect(snapshot[snapshot.length - 1]).toMatchObject({ row: 13, number: 5 });
  });

  it('reports booked reservations as booked regardless of expiry', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('snapshot-buyer');
    await createReservation(userId, instanceId, 'booked', -60, [await seatId(instanceId, 3, 4)]);

    const snapshot = await getSnapshot(instanceId);

    const booked = seatAt(snapshot, 3, 4);
    expect(booked.status).toBe('booked');
    expect(booked.userId).toBe(userId);
  });

  it('collapses a seat carrying both dead and live reservations to one reserved entry', async () => {
    const instanceId = await mainHallId();
    const deadUserId = await createUser('snapshot-lapsed');
    const liveUserId = await createUser('snapshot-current');

    // Nothing in the schema stops one seat from being linked to several
    // reservations, so a seat can produce several rows out of the join: the
    // dead ones come back with NULL reservation columns and must never mask
    // the live hold. Both insertion orders are covered because the join row
    // order is not guaranteed.
    const deadFirstSeat = await seatId(instanceId, 5, 5);
    await createReservation(deadUserId, instanceId, 'held', -30, [deadFirstSeat]);
    await createReservation(liveUserId, instanceId, 'held', 15, [deadFirstSeat]);

    const liveFirstSeat = await seatId(instanceId, 6, 6);
    await createReservation(liveUserId, instanceId, 'held', 15, [liveFirstSeat]);
    await createReservation(deadUserId, instanceId, 'released', 15, [liveFirstSeat]);

    const snapshot = await getSnapshot(instanceId);

    // The count only holds if the extra join rows were collapsed away.
    expect(snapshot).toHaveLength(115);

    for (const [row, number] of [
      [5, 5],
      [6, 6],
    ] as const) {
      expect(snapshot.filter((s) => s.row === row && s.number === number)).toHaveLength(1);
      const seat = seatAt(snapshot, row, number);
      expect(seat.status).toBe('reserved');
      expect(seat.userId).toBe(liveUserId);
      expect(seat.expiresAt).toMatch(ISO_UTC);
      expect(new Date(seat.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    }

    expect(new Set(snapshot.map((s) => s.id)).size).toBe(115);
  });

  it('ignores released reservations', async () => {
    const instanceId = await mainHallId();
    const userId = await createUser('snapshot-quitter');
    await createReservation(userId, instanceId, 'released', 15, [await seatId(instanceId, 4, 4)]);

    const snapshot = await getSnapshot(instanceId);

    expect(seatAt(snapshot, 4, 4).status).toBe('available');
  });
});

describe('GET /api/map-instances', () => {
  it('returns 401 without a valid cookie', async () => {
    const res = await request(app).get('/api/map-instances');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('returns the instance list to an authenticated user', async () => {
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ username: 'instances-reader', password: 'Passw0rd' });
    expect(registered.status).toBe(201);
    const cookie = registered.headers['set-cookie'];

    const res = await request(app).get('/api/map-instances').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toContainEqual({ id: expect.any(Number), name: 'Main Hall' });
    for (const instance of res.body as unknown[]) {
      expect(Object.keys(instance as object).sort()).toEqual(['id', 'name']);
    }
  });
});
