import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';

export const instancesRouter: Router = Router();

/** Lists the selectable map instances. Authenticated users only. */
instancesRouter.get('/', requireAuth, async (_req: Request, res: Response) => {
  const found = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM map_instances ORDER BY id`,
  );
  res.status(200).json(found.rows);
});
