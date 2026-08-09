import express from 'express';
import cookieParser from 'cookie-parser';
import { authRouter } from './auth/routes.js';

/**
 * Builds the Express application. Kept separate from `index.ts` (server
 * bootstrap) so tests can drive it via supertest without opening a port.
 */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  return app;
}
