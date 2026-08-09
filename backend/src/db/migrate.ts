import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from './pool.js';

const MAIN_HALL = 'Main Hall';

/** rows 1-10 have seats 1-10; rows 11-13 have seats 1-5 => 115 seats. */
function seatLayout(): { rowNumber: number; seatNumber: number }[] {
  const seats: { rowNumber: number; seatNumber: number }[] = [];
  for (let rowNumber = 1; rowNumber <= 10; rowNumber++) {
    for (let seatNumber = 1; seatNumber <= 10; seatNumber++) {
      seats.push({ rowNumber, seatNumber });
    }
  }
  for (let rowNumber = 11; rowNumber <= 13; rowNumber++) {
    for (let seatNumber = 1; seatNumber <= 5; seatNumber++) {
      seats.push({ rowNumber, seatNumber });
    }
  }
  return seats;
}

export async function migrate(): Promise<void> {
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  await pool.query(
    `INSERT INTO map_instances (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [MAIN_HALL],
  );
  const instance = await pool.query<{ id: number }>(
    `SELECT id FROM map_instances WHERE name = $1`,
    [MAIN_HALL],
  );
  const instanceId = instance.rows[0].id;

  const seats = seatLayout();
  const values: unknown[] = [instanceId];
  const tuples = seats.map((seat) => {
    values.push(seat.rowNumber, seat.seatNumber);
    return `($1, $${values.length - 1}, $${values.length})`;
  });
  await pool.query(
    `INSERT INTO seats (instance_id, row_number, seat_number)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .then(() => {
      console.log('migration complete');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
