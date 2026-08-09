import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import {
  DomainError,
  bookReservation,
  modifyReservation,
  releaseReservation,
  reserve,
} from './service.js';

export const reservationsRouter: Router = Router();

/**
 * Shape check only. Range/duplicate rules live in the service, so a direct
 * caller (tests, the WebSocket layer) gets the same guarantees as HTTP.
 */
function parseSeatIds(body: unknown): number[] {
  if (typeof body !== 'object' || body === null) {
    throw new DomainError('INVALID_INPUT', 400, 'Request body must be an object');
  }
  const { seatIds } = body as { seatIds?: unknown };
  if (!Array.isArray(seatIds)) {
    throw new DomainError('INVALID_INPUT', 400, 'seatIds must be an array of seat ids');
  }
  if (seatIds.some((seatId) => typeof seatId !== 'number')) {
    throw new DomainError('INVALID_INPUT', 400, 'Every seat id must be a number');
  }
  return seatIds as number[];
}

function parseReserveBody(body: unknown): { instanceId: number; seatIds: number[] } {
  const seatIds = parseSeatIds(body);
  const { instanceId } = body as { instanceId?: unknown };
  if (typeof instanceId !== 'number') {
    throw new DomainError('INVALID_INPUT', 400, 'instanceId must be a number');
  }
  return { instanceId, seatIds };
}

/**
 * Narrows `req.userId` for a handler mounted behind `requireAuth`. The 401 is
 * unreachable in practice; it keeps the handlers total without a cast.
 */
function authedUserId(req: Request, res: Response): number | null {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return null;
  }
  return userId;
}

/**
 * Turns an expected failure into the `{ error, code }` envelope. Anything else
 * is not ours to describe: re-thrown, Express 5 forwards the rejection to the
 * terminal handler, which answers an opaque 500.
 */
function respondError(res: Response, err: unknown): void {
  if (err instanceof DomainError) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

/** Creates a held reservation group. Owner is taken from the auth cookie. */
reservationsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const userId = authedUserId(req, res);
  if (userId === null) return;

  try {
    const { instanceId, seatIds } = parseReserveBody(req.body);
    const created = await reserve(userId, instanceId, seatIds);
    res.status(201).json(created);
  } catch (err) {
    respondError(res, err);
  }
});

/**
 * Replaces the seats of a held group. The body carries the COMPLETE new
 * selection, not a delta, and the hold window restarts on success.
 */
reservationsRouter.patch('/:id/seats', requireAuth, async (req: Request, res: Response) => {
  const userId = authedUserId(req, res);
  if (userId === null) return;

  try {
    const seatIds = parseSeatIds(req.body);
    // A non-numeric id becomes NaN, which the service rejects as INVALID_INPUT
    // along with every other id that cannot name a reservation.
    const updated = await modifyReservation(userId, Number(req.params.id), seatIds);
    res.status(200).json(updated);
  } catch (err) {
    respondError(res, err);
  }
});

/**
 * Confirms a held group. Idempotent: re-booking a group already booked by this
 * same user answers 200 as well, so a double click cannot produce an error.
 */
reservationsRouter.post('/:id/book', requireAuth, async (req: Request, res: Response) => {
  const userId = authedUserId(req, res);
  if (userId === null) return;

  try {
    const booked = await bookReservation(userId, Number(req.params.id));
    res.status(200).json(booked);
  } catch (err) {
    respondError(res, err);
  }
});

/** Gives up a held group. 204: there is nothing left to describe. */
reservationsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = authedUserId(req, res);
  if (userId === null) return;

  try {
    await releaseReservation(userId, Number(req.params.id));
    res.status(204).end();
  } catch (err) {
    respondError(res, err);
  }
});
