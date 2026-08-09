import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

// These cases fail before any route handler runs, so they need no database.
const app = createApp();

describe('error envelope', () => {
  it('answers a malformed JSON body with 400 INVALID_INPUT', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('not-json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON body', code: 'INVALID_INPUT' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('never leaks a stack trace in the body', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"username":');

    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/at .*\(/);
  });
});
