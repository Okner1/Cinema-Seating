import type { NextFunction, Request, Response } from 'express';
import { COOKIE_NAME, verifyToken } from './jwt.js';

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

/** Rejects with 401 unless the request carries a valid, unexpired auth cookie. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[COOKIE_NAME];
  if (typeof token !== 'string' || token.length === 0) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return;
  }
  const payload = verifyToken(token);
  if (payload === null) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return;
  }
  req.userId = payload.userId;
  next();
}
