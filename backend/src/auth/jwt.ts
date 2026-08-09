import * as jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const COOKIE_NAME = 'token';

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: TOKEN_TTL_SECONDS * 1000,
} as const;

export function signToken(userId: number): string {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: TOKEN_TTL_SECONDS });
}

/** Returns the payload, or `null` for a missing/garbage/expired/foreign token. */
export function verifyToken(token: string): { userId: number } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload !== 'object' || payload === null) return null;
    const userId = (payload as jwt.JwtPayload).userId;
    if (typeof userId !== 'number' || !Number.isInteger(userId)) return null;
    return { userId };
  } catch {
    return null;
  }
}
