import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { DomainError, reserve } from '../src/reservations/service.js';

/**
 * These tests drive `reserve()` directly rather than through HTTP: the two
 * attempts must overlap inside the database, and every HTTP hop in between only
 * widens the window in which one transaction finishes before the other starts.
 *
 * Each `reserve()` call checks out its own connection from the pool (default
 * max 10), so the two attempts really are two concurrent Postgres backends —
 * the same thing two dedicated `pg.Client`s would give us, without having to
 * thread a client through the service.
 *
 * Each race is repeated a few times: interleaving is not deterministic, and a
 * single round could accidentally serialize completely and prove nothing.
 */
const ROUNDS = 5;

async function mainHallId(): Promise<number> {
  const found = await pool.query<{ id: number }>(`SELECT id FROM map_instances WHERE name = $1`, [
    'Main Hall',
  ]);
  return found.rows[0].id;
}

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

/**
 * Splits an allSettled outcome and asserts exactly one attempt won, with the
 * loser rejected by `expectedCode`. Returns the winner for further assertions.
 */
function expectExactlyOneWinner<T>(
  results: PromiseSettledResult<T>[],
  expectedCode: string,
): T {
  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled',
  );
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  const reasons = rejected.map((r) =>
    r.reason instanceof Error ? `${r.reason.name}: ${r.reason.message}` : String(r.reason),
  );
  expect(fulfilled.length, `expected exactly 1 winner, rejections: ${reasons.join(' | ')}`).toBe(1);
  expect(rejected).toHaveLength(1);

  const reason: unknown = rejected[0].reason;
  expect(reason).toBeInstanceOf(DomainError);
  expect((reason as DomainError).code).toBe(expectedCode);
  return fulfilled[0].value;
}

async function activeHeldGroups(): Promise<{ id: number; seatIds: number[] }[]> {
  const found = await pool.query<{ id: number; seat_ids: number[] }>(
    `SELECT r.id, array_agg(rs.seat_id ORDER BY rs.seat_id) AS seat_ids
     FROM reservations r
     JOIN reservation_seats rs ON rs.reservation_id = r.id
     WHERE r.status = 'held' AND r.expires_at > clock_timestamp()
     GROUP BY r.id
     ORDER BY r.id`,
  );
  return found.rows.map((r) => ({ id: r.id, seatIds: r.seat_ids }));
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

/** Between rounds: drop the reservations but keep the users. */
async function clearReservations(): Promise<void> {
  await pool.query('TRUNCATE reservations, reservation_seats RESTART IDENTITY CASCADE');
}

describe('concurrent reserve()', () => {
  it('lets exactly one of two users hold the same seats; the loser gets SEAT_TAKEN', async () => {
    const instanceId = await mainHallId();
    const userA = await createUser('race-a');
    const userB = await createUser('race-b');
    const contested = await seatIds(instanceId, 1, [3, 4]);

    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.allSettled([
        reserve(userA, instanceId, contested),
        reserve(userB, instanceId, contested),
      ]);

      const winner = expectExactlyOneWinner(results, 'SEAT_TAKEN');
      expect(winner.seatIds).toEqual(contested);

      // The database must agree: one live group, holding exactly those seats.
      const groups = await activeHeldGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(winner.reservationId);
      expect(groups[0].seatIds).toEqual([...contested].sort((a, b) => a - b));

      await clearReservations();
    }
  });

  it('stops two disjoint holds from jointly stranding a seat; the loser gets TRAPPED_SEAT', async () => {
    const instanceId = await mainHallId();
    const userA = await createUser('trap-a');
    const userB = await createUser('trap-b');

    // Empty row. {1,2} and {4,5} are each perfectly legal on their own — it is
    // only their combination that strands seat 3. Neither request can see the
    // other's seats, so a per-seat lock would let both through and the row
    // would end up illegal; only the whole-row lock forces them to serialize,
    // after which the loser evaluates Rule 2 against the winner's committed
    // seats. The seat sets are disjoint, so SEAT_TAKEN is impossible here:
    // the loser can only fail on Rule 2.
    const left = await seatIds(instanceId, 2, [1, 2]);
    const right = await seatIds(instanceId, 2, [4, 5]);

    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.allSettled([
        reserve(userA, instanceId, left),
        reserve(userB, instanceId, right),
      ]);

      const winner = expectExactlyOneWinner(results, 'TRAPPED_SEAT');
      expect([left, right]).toContainEqual(winner.seatIds);

      const groups = await activeHeldGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(winner.reservationId);
      expect(groups[0].seatIds).toEqual([...winner.seatIds].sort((a, b) => a - b));

      await clearReservations();
    }
  });
});
