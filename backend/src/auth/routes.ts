import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { COOKIE_NAME, COOKIE_OPTIONS, signToken } from './jwt.js';
import { requireAuth } from './middleware.js';
import {
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
  verifyPasswordAgainstDummy,
} from './password.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

const INVALID_CREDENTIALS = {
  error: 'Invalid credentials',
  code: 'INVALID_CREDENTIALS',
} as const;

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message, code: 'INVALID_INPUT' });
}

/**
 * Pulls `username`/`password` out of a request body, returning an error message
 * when either is missing or not a non-empty string.
 */
function readCredentials(body: unknown): { username: string; password: string } | string {
  if (typeof body !== 'object' || body === null) return 'Username and password are required';
  const { username, password } = body as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || username.trim().length === 0) {
    return 'Username is required';
  }
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required';
  }
  return { username: username.trim(), password };
}

export const authRouter: Router = Router();

authRouter.post('/register', async (req: Request, res: Response) => {
  const credentials = readCredentials(req.body);
  if (typeof credentials === 'string') {
    badRequest(res, credentials);
    return;
  }
  const policyError = validatePasswordPolicy(credentials.password);
  if (policyError !== null) {
    badRequest(res, policyError);
    return;
  }

  const passwordHash = await hashPassword(credentials.password);
  let user: { id: number; username: string };
  try {
    const inserted = await pool.query<{ id: number; username: string }>(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`,
      [credentials.username, passwordHash],
    );
    user = inserted.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      res.status(409).json({ error: 'Username already taken', code: 'USERNAME_TAKEN' });
      return;
    }
    throw err;
  }

  // Registration auto-logs-in.
  res.cookie(COOKIE_NAME, signToken(user.id), COOKIE_OPTIONS);
  res.status(201).json({ id: user.id, username: user.username });
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const credentials = readCredentials(req.body);
  if (typeof credentials === 'string') {
    // Do not leak which field was wrong on a login attempt.
    res.status(401).json(INVALID_CREDENTIALS);
    return;
  }

  const found = await pool.query<UserRow>(
    `SELECT id, username, password_hash FROM users WHERE username = $1`,
    [credentials.username],
  );
  const user = found.rows[0];

  // Unknown user still pays for one bcrypt comparison so that the failure is
  // indistinguishable from a wrong password.
  const ok =
    user === undefined
      ? await verifyPasswordAgainstDummy(credentials.password)
      : await verifyPassword(credentials.password, user.password_hash);

  if (!ok || user === undefined) {
    res.status(401).json(INVALID_CREDENTIALS);
    return;
  }

  res.cookie(COOKIE_NAME, signToken(user.id), COOKIE_OPTIONS);
  res.status(200).json({ id: user.id, username: user.username });
});

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const found = await pool.query<{ id: number; username: string }>(
    `SELECT id, username FROM users WHERE id = $1`,
    [req.userId],
  );
  const user = found.rows[0];
  if (user === undefined) {
    // Valid token for a user that no longer exists.
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return;
  }
  res.status(200).json({ id: user.id, username: user.username });
});

authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: COOKIE_OPTIONS.httpOnly,
    secure: COOKIE_OPTIONS.secure,
    sameSite: COOKIE_OPTIONS.sameSite,
  });
  res.status(204).end();
});
