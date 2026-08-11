import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { COOKIE_NAME, verifyToken } from '../auth/jwt.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import * as hub from './hub.js';
import { getSnapshot } from './snapshot.js';

export const WS_PATH = '/api/ws';

/**
 * How many heartbeats may go unanswered before the socket is torn down. Two,
 * so a single dropped frame or a briefly busy client is not fatal.
 */
const MAX_MISSED_PONGS = 2;

/** A live client: a ws socket plus the identity and room it was accepted for. */
interface ClientSocket extends WebSocket {
  userId: number;
  instanceId: number;
  missedPongs: number;
}

type Upgrade =
  | { ok: true; userId: number; instanceId: number }
  | { ok: false; status: number; reason: string };

/**
 * Reads one cookie out of a raw `Cookie` header. The upgrade request never
 * passes through Express, so `cookie-parser` is not available here — and a
 * dedicated dependency would be overkill for one lookup.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Authenticates and validates an upgrade request. Everything is settled here,
 * before the handshake: a socket that reaches `onConnected` is already known to
 * belong to a real user watching a real instance.
 */
async function authorize(req: IncomingMessage): Promise<Upgrade> {
  // The base is a formality — only the path and the query are ever read.
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== WS_PATH) {
    return { ok: false, status: 404, reason: 'Not Found' };
  }

  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  const payload = token === null ? null : verifyToken(token);
  if (payload === null) {
    return { ok: false, status: 401, reason: 'Unauthorized' };
  }

  const raw = url.searchParams.get('instanceId');
  const instanceId = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(instanceId) || instanceId <= 0) {
    return { ok: false, status: 400, reason: 'Bad Request' };
  }

  const found = await pool.query(`SELECT 1 FROM map_instances WHERE id = $1`, [instanceId]);
  if (found.rows.length === 0) {
    return { ok: false, status: 404, reason: 'Not Found' };
  }

  return { ok: true, userId: payload.userId, instanceId };
}

/**
 * Answers a refused upgrade on the raw socket. There is no `res` object at this
 * point in the HTTP lifecycle, so the status line is written by hand — the
 * client sees a normal HTTP response instead of a silent hang.
 */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Sends the full current state of the client's instance.
 *
 * The sequence number is read BEFORE the query on purpose: should a broadcast
 * land while the snapshot is being read, its `seq` is then strictly greater and
 * the client applies it on top instead of discarding it as already-seen.
 */
async function sendSnapshot(client: ClientSocket): Promise<void> {
  const seq = hub.currentSeq(client.instanceId);
  const seats = await getSnapshot(client.instanceId);
  hub.send(client, {
    type: 'snapshot',
    seq,
    seats: hub.personalize(seats, client.userId),
    myReservation: hub.myReservationOf(seats, client.userId),
  });
}

/** Client frames: `{type:'pong'}` and `{type:'sync'}`. Anything else is ignored. */
async function onMessage(client: ClientSocket, raw: RawData): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (typeof message !== 'object' || message === null) return;

  const { type } = message as { type?: unknown };
  if (type === 'pong') {
    client.missedPongs = 0;
    return;
  }
  if (type === 'sync') {
    await sendSnapshot(client);
  }
}

async function onConnected(client: ClientSocket, userId: number, instanceId: number): Promise<void> {
  client.userId = userId;
  client.instanceId = instanceId;
  client.missedPongs = 0;
  hub.join(instanceId, client);

  // Application-level heartbeat rather than a protocol ping frame: the browser
  // answers protocol pings automatically, which proves the socket is open but
  // not that the page is still running. `seq` rides along so an idle client can
  // detect a missed delta without waiting for the next one.
  const heartbeat = setInterval(() => {
    if (client.missedPongs >= MAX_MISSED_PONGS) {
      clearInterval(heartbeat);
      client.terminate();
      return;
    }
    client.missedPongs += 1;
    hub.send(client, { type: 'ping', seq: hub.currentSeq(instanceId) });
  }, config.heartbeatMs);

  client.on('message', (raw) => {
    onMessage(client, raw).catch((err: unknown) => {
      console.error('[ws] failed to handle a client message', err);
    });
  });
  client.on('close', () => {
    clearInterval(heartbeat);
    hub.leave(instanceId, client);
  });
  client.on('error', (err) => {
    console.error('[ws] socket error', err);
  });

  try {
    await sendSnapshot(client);
  } catch (err) {
    // Without an initial state the client has nothing to render and no way to
    // ask for one, so close instead of leaving it staring at an empty map.
    console.error('[ws] failed to send the initial snapshot', err);
    client.close(1011, 'snapshot failed');
  }
}

/**
 * Serves `/api/ws` on the SAME http server as the REST API — one port, one
 * origin, and the session cookie is sent with the upgrade for free.
 */
export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // A peer can reset the connection mid-handshake; without this listener that
    // becomes an unhandled 'error' event and takes the process down.
    socket.on('error', (err) => {
      console.error('[ws] upgrade socket error', err);
    });

    authorize(req)
      .then((outcome) => {
        if (!outcome.ok) {
          refuse(socket, outcome.status, outcome.reason);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          onConnected(ws as ClientSocket, outcome.userId, outcome.instanceId).catch(
            (err: unknown) => {
              console.error('[ws] failed to set up a connection', err);
            },
          );
        });
      })
      .catch((err: unknown) => {
        console.error('[ws] upgrade failed', err);
        refuse(socket, 500, 'Internal Server Error');
      });
  });

  return wss;
}
