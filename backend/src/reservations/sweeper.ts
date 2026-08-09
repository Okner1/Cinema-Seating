import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { SEAT_CHANGES_CHANNEL } from './service.js';

/**
 * Retires holds whose window has closed and announces every instance they
 * touched.
 *
 * Correctness never depends on this running: every read path already applies
 * lazy expiry (`expires_at > clock_timestamp()`), so a lapsed hold stops
 * blocking a seat the moment it lapses, sweeper or no sweeper. What the sweeper
 * buys is the PUSH — a client whose last delta showed those seats as reserved
 * has no reason to ask again, and would keep them greyed out until something
 * else happened in the room. It also keeps `status` honest for anyone reading
 * the table directly.
 *
 * One statement, no transaction: `UPDATE ... RETURNING` is atomic by itself,
 * and the `status = 'held'` filter makes it idempotent — a row already swept
 * (or booked, or released) is simply not matched again.
 */
const SWEEP_SQL = `
  UPDATE reservations
  SET status = 'expired'
  WHERE status = 'held' AND expires_at <= clock_timestamp()
  RETURNING instance_id
`;

/**
 * Expires every lapsed hold and notifies once per affected instance. Returns
 * those instance ids, which makes the pass observable from a test.
 */
export async function sweepExpiredHolds(): Promise<number[]> {
  const swept = await pool.query<{ instance_id: number }>(SWEEP_SQL);
  // One notification per instance, not per reservation: the payload only names
  // the room to re-read, so repeats would cost redundant snapshots.
  const instanceIds = [...new Set(swept.rows.map((row) => row.instance_id))];

  for (const instanceId of instanceIds) {
    await pool.query(`SELECT pg_notify($1, $2)`, [
      SEAT_CHANGES_CHANNEL,
      JSON.stringify({ instanceId }),
    ]);
  }
  return instanceIds;
}

/**
 * Runs the sweep every `sweepIntervalMs`. A failed pass is logged and skipped:
 * the next one picks up exactly the same rows, since nothing about the query
 * depends on the previous result.
 */
export function startSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    sweepExpiredHolds().catch((err: unknown) => {
      console.error('[sweeper] pass failed', err);
    });
  }, config.sweepIntervalMs);
}
