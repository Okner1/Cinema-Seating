import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { DomainError, reserve } from './service.js';

export const reservationsRouter: Router = Router();

/**
 * Shape check only. Range/duplicate rules live in the service, so a direct
 * caller (tests, the WebSocket layer) gets the same guarantees as HTTP.
 */
function parseReserveBody(body: unknown): { instanceId: number; seatIds: number[] } {
  if (typeof body !== 'object' || body === null) {
    throw new DomainError('INVALID_INPUT', 400, 'Request body must be an object');
  }
  const { instanceId, seatIds } = body as { instanceId?: unknown; seatIds?: unknown };
  if (typeof instanceId !== 'number') {
    throw new DomainError('INVALID_INPUT', 400, 'instanceId must be a number');
  }
  if (!Array.isArray(seatIds)) {
    throw new DomainError('INVALID_INPUT', 400, 'seatIds must be an array of seat ids');
  }
  if (seatIds.some((seatId) => typeof seatId !== 'number')) {
    throw new DomainError('INVALID_INPUT', 400, 'Every seat id must be a number');
  }
  return { instanceId, seatIds: seatIds as number[] };
}

/** Creates a held reservation group. Owner is taken from the auth cookie. */
reservationsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId;
  if (userId === undefined) {
    // Unreachable behind requireAuth; keeps the handler total without a cast.
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return;
  }

  try {
    const { instanceId, seatIds } = parseReserveBody(req.body);
    const created = await reserve(userId, instanceId, seatIds);
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof DomainError) {
      res.status(err.httpStatus).json({ error: err.message, code: err.code });
      return;
    }
    // Anything unexpected is not ours to describe: Express 5 forwards the
    // rejection to the terminal handler, which answers an opaque 500.
    throw err;
  }
});
