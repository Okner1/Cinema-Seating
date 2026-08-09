import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { authRouter } from './auth/routes.js';
import { instancesRouter } from './instances/routes.js';

/**
 * Terminal error handler. Express only treats a 4-argument middleware as an
 * error handler, so `next` must stay in the signature even though it is unused.
 *
 * Keeps every response on the `{ error, code }` envelope: body-parser's
 * SyntaxError becomes a 400, anything else becomes an opaque 500 (the real
 * error is logged server-side, never sent to the client).
 */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Malformed JSON body', code: 'INVALID_INPUT' });
    return;
  }
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
}

/**
 * Builds the Express application. Kept separate from `index.ts` (server
 * bootstrap) so tests can drive it via supertest without opening a port.
 */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api/map-instances', instancesRouter);
  app.use(errorHandler);
  return app;
}
