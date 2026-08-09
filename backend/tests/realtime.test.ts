import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { startListener, stopListener } from '../src/realtime/listener.js';
import { attachWebSocketServer } from '../src/realtime/wsServer.js';
import { reserve } from '../src/reservations/service.js';

/** One server-to-client frame, already parsed. */
interface ServerMessage {
  type: string;
  seq: number;
  seats?: ClientSeat[];
}

interface ClientSeat {
  id: number;
  row: number;
  number: number;
  status: string;
  expiresAt: string | null;
  mine: boolean;
}

const app = createApp();
const server = http.createServer(app);
const sockets: WebSocket[] = [];

let port = 0;

function url(query: string): string {
  return `ws://127.0.0.1:${port}/api/ws${query}`;
}

async function mainHallId(): Promise<number> {
  const found = await pool.query<{ id: number }>(`SELECT id FROM map_instances WHERE name = $1`, [
    'Main Hall',
  ]);
  return found.rows[0].id;
}

async function seatId(instanceId: number, row: number, number: number): Promise<number> {
  const found = await pool.query<{ id: number }>(
    `SELECT id FROM seats WHERE instance_id = $1 AND row_number = $2 AND seat_number = $3`,
    [instanceId, row, number],
  );
  return found.rows[0].id;
}

/** Registers a user and returns its id plus the raw `token=...` cookie pair. */
async function register(username: string): Promise<{ userId: number; cookie: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'Passw0rd' });
  expect(res.status).toBe(201);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return { userId: res.body.id as number, cookie: setCookie[0].split(';')[0] };
}

/** Everything a socket has received that no assertion has claimed yet. */
interface Inbox {
  messages: ServerMessage[];
  failure: Error | null;
  notify: (() => void) | null;
}

const inboxes = new Map<WebSocket, Inbox>();

/**
 * Opens a client socket with `cookie` and waits for the handshake. Every socket
 * is registered for teardown so a failing expectation cannot leave vitest
 * hanging on an open handle.
 *
 * Frames are buffered from CONSTRUCTION, before the handshake even completes.
 * `ws` delivers messages as events and replays nothing, while the server sends
 * the snapshot the instant a connection is accepted — a listener attached after
 * the fact would miss it, and every wait would be a race against the server
 * being quick.
 */
function open(cookie: string, query: string): Promise<WebSocket> {
  const ws = new WebSocket(url(query), { headers: { Cookie: cookie } });
  sockets.push(ws);

  const inbox: Inbox = { messages: [], failure: null, notify: null };
  inboxes.set(ws, inbox);
  ws.on('message', (raw: WebSocket.RawData) => {
    inbox.messages.push(JSON.parse(raw.toString()) as ServerMessage);
    inbox.notify?.();
  });
  ws.on('error', (err: Error) => {
    // Hand the failure to whoever is waiting instead of making them sit out the
    // whole timeout.
    inbox.failure = err;
    inbox.notify?.();
  });

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

/**
 * Takes the next message of type `type` out of the socket's inbox, waiting for
 * one only if none has arrived yet. Heartbeat pings share the wire and are left
 * in the buffer rather than treated as failures.
 */
async function waitFor(ws: WebSocket, type: string, timeoutMs = 5000): Promise<ServerMessage> {
  const inbox = inboxes.get(ws);
  if (inbox === undefined) throw new Error('this socket was not opened through open()');
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (inbox.failure !== null) throw inbox.failure;
    // Consumed, not peeked: a later wait for the same type must see the NEXT one.
    const index = inbox.messages.findIndex((message) => message.type === type);
    if (index !== -1) return inbox.messages.splice(index, 1)[0];

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for a "${type}" message`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        inbox.notify = null;
        resolve();
      }, remaining);
      inbox.notify = () => {
        clearTimeout(timer);
        inbox.notify = null;
        resolve();
      };
    });
  }
}

/** Resolves with the handshake error of a connection that must be refused. */
function expectRefused(query: string, headers: Record<string, string>): Promise<Error> {
  const ws = new WebSocket(url(query), { headers });
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.on('error', resolve);
    ws.on('open', () => {
      reject(new Error('the connection was accepted but should have been refused'));
    });
  });
}

function seatIn(message: ServerMessage, id: number): ClientSeat {
  const found = (message.seats ?? []).find((seat) => seat.id === id);
  expect(found).toBeDefined();
  return found as ClientSeat;
}

beforeAll(async () => {
  await migrate();
  attachWebSocketServer(server);
  startListener();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(async () => {
  await pool.query('TRUNCATE users, reservations, reservation_seats RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await stopListener();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('WebSocket realtime layer', () => {
  it('sends a personalised snapshot, then a delta with the next seq when seats are taken', async () => {
    const instanceId = await mainHallId();
    const holder = await register('ws-holder');
    const watcher = await register('ws-watcher');

    const holderWs = await open(holder.cookie, `?instanceId=${instanceId}`);
    const watcherWs = await open(watcher.cookie, `?instanceId=${instanceId}`);

    const snapshot = await waitFor(holderWs, 'snapshot');
    await waitFor(watcherWs, 'snapshot');

    expect(snapshot.seats).toHaveLength(115);
    for (const seat of snapshot.seats ?? []) {
      expect(seat.mine).toBe(false);
      expect(seat.status).toBe('available');
      // The owner is never put on the wire: `mine` is the only ownership signal.
      expect(Object.prototype.hasOwnProperty.call(seat, 'userId')).toBe(false);
    }

    const wanted = [await seatId(instanceId, 1, 1), await seatId(instanceId, 1, 2)];

    await reserve(holder.userId, instanceId, wanted);

    // Safe to wait only now: the inbox buffers whatever landed while `reserve`
    // was still running.
    const mine = await waitFor(holderWs, 'delta');
    const theirs = await waitFor(watcherWs, 'delta');

    expect(mine.seq).toBe(snapshot.seq + 1);
    expect(theirs.seq).toBe(snapshot.seq + 1);
    expect(mine.seats).toHaveLength(115);
    for (const id of wanted) {
      expect(seatIn(mine, id).status).toBe('reserved');
      expect(seatIn(mine, id).mine).toBe(true);
      // Same seats, same status, opposite ownership for the other user.
      expect(seatIn(theirs, id).status).toBe('reserved');
      expect(seatIn(theirs, id).mine).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(seatIn(theirs, id), 'userId')).toBe(false);
    }

    // `sync` re-sends the current state without moving the sequence forward.
    holderWs.send(JSON.stringify({ type: 'sync' }));
    const fresh = await waitFor(holderWs, 'snapshot');

    expect(fresh.seq).toBe(mine.seq);
    expect(fresh.seats).toHaveLength(115);
    for (const id of wanted) {
      expect(seatIn(fresh, id).status).toBe('reserved');
      expect(seatIn(fresh, id).mine).toBe(true);
    }
  });

  it('refuses a connection without an authentication cookie', async () => {
    const instanceId = await mainHallId();

    const err = await expectRefused(`?instanceId=${instanceId}`, {});

    expect(err.message).toContain('401');
  });

  it('refuses a connection for an instance that does not exist', async () => {
    const user = await register('ws-lost');

    const err = await expectRefused('?instanceId=999999', { Cookie: user.cookie });

    expect(err.message).toContain('404');
  });

  it('refuses a connection without an instanceId', async () => {
    const user = await register('ws-nowhere');

    const err = await expectRefused('', { Cookie: user.cookie });

    expect(err.message).toContain('400');
  });
});
