import { describe, it, expect, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

afterAll(async () => {
  await pool.end();
});

describe('migrate', () => {
  it('is idempotent and seeds exactly 115 seats', async () => {
    await migrate();
    await migrate();

    const instance = await pool.query<{ id: number }>(
      `SELECT id FROM map_instances WHERE name = $1`,
      ['Main Hall'],
    );
    expect(instance.rows).toHaveLength(1);
    const instanceId = instance.rows[0].id;

    const total = await pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE instance_id = $1`,
      [instanceId],
    );
    expect(Number(total.rows[0].count)).toBe(115);

    const rowEleven = await pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE instance_id = $1 AND row_number = 11`,
      [instanceId],
    );
    expect(Number(rowEleven.rows[0].count)).toBe(5);
  });
});
