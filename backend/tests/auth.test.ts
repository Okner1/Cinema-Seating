import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

const app = createApp();

const VALID = { username: 'alice', password: 'Passw0rd' };

/** Pulls the raw `token=...` cookie string out of a Set-Cookie header list. */
function tokenCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const found = list.find((c) => c.startsWith('token='));
  expect(found).toBeDefined();
  return found as string;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query('TRUNCATE users, reservations, reservation_seats RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('POST /api/auth/register', () => {
  it('creates a user, returns 201 {id, username} and sets an HttpOnly cookie', async () => {
    const res = await request(app).post('/api/auth/register').send(VALID);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number), username: 'alice' });
    expect(res.body.password).toBeUndefined();
    expect(res.body.password_hash).toBeUndefined();

    const cookie = tokenCookie(res.headers as Record<string, unknown>);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=86400/i);
  });

  it.each([['abc'], ['alllower1'], ['ALLUPPER1'], ['NoDigits']])(
    'rejects password %s with 400 INVALID_INPUT',
    async (password) => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'bob', password });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
      expect(typeof res.body.error).toBe('string');
      expect(res.headers['set-cookie']).toBeUndefined();
    },
  );

  it('rejects a duplicate username with 409 USERNAME_TAKEN', async () => {
    const first = await request(app).post('/api/auth/register').send(VALID);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'Different1' });

    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: expect.any(String), code: 'USERNAME_TAKEN' });
  });
});

describe('POST /api/auth/login', () => {
  it('returns 200 {id, username} and a cookie for correct credentials', async () => {
    const registered = await request(app).post('/api/auth/register').send(VALID);

    const res = await request(app).post('/api/auth/login').send(VALID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: registered.body.id, username: 'alice' });
    expect(tokenCookie(res.headers as Record<string, unknown>)).toMatch(/HttpOnly/i);
  });

  it('returns an identical 401 body for a wrong password and an unknown user', async () => {
    await request(app).post('/api/auth/register').send(VALID);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'Wr0ngPass' });
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'Wr0ngPass' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual({
      error: 'Invalid credentials',
      code: 'INVALID_CREDENTIALS',
    });
    expect(unknownUser.body).toEqual(wrongPassword.body);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    expect(unknownUser.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user when the cookie is present', async () => {
    const registered = await request(app).post('/api/auth/register').send(VALID);
    const cookie = tokenCookie(registered.headers as Record<string, unknown>);

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: registered.body.id, username: 'alice' });
  });

  it('returns 401 without a cookie', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe('string');
    expect(typeof res.body.code).toBe('string');
  });

  it('returns 401 for a garbage token', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', 'token=not-a-jwt');

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie and returns 204', async () => {
    const registered = await request(app).post('/api/auth/register').send(VALID);
    const cookie = tokenCookie(registered.headers as Record<string, unknown>);

    const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);

    expect(res.status).toBe(204);
    const cleared = tokenCookie(res.headers as Record<string, unknown>);
    expect(cleared).toMatch(/^token=;/);
  });
});
