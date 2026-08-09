import { Client } from 'pg';
import { config } from '../config.js';
import { SEAT_CHANGES_CHANNEL } from '../reservations/service.js';
import * as hub from './hub.js';

/**
 * How long to wait before dialling back in after the listening connection dies.
 * Nothing is buffered while it is down: every client detects the resulting gap
 * in `seq` and resyncs, so a lost notification costs one extra snapshot, not
 * correctness.
 */
const RECONNECT_DELAY_MS = 1000;

let active: Client | null = null;
let running = false;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let cancelWait: (() => void) | null = null;

/** A sleep that `stopListener` can cut short. */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      cancelWait = null;
      resolve();
    }, ms);
    cancelWait = resolve;
  });
}

/**
 * Turns one notification into one broadcast. The payload carries only the
 * instance id — the seat state is re-derived from the database, which keeps the
 * message far below `pg_notify`'s 8000-byte limit and makes every listener
 * agree on what "current" means.
 */
function onNotification(payload: string | undefined): void {
  if (payload === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    console.error('[listener] ignoring an unparseable notification payload');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const { instanceId } = parsed as { instanceId?: unknown };
  if (typeof instanceId !== 'number' || !Number.isInteger(instanceId)) return;

  hub.broadcast(instanceId).catch((err: unknown) => {
    console.error('[listener] broadcast failed', err);
  });
}

/**
 * One listening connection, from dial to death. Resolves when the connection
 * closes cleanly, rejects when it fails; either way the caller reconnects.
 *
 * The client is created directly rather than checked out of the pool: a
 * `LISTEN` binds to a specific backend session for as long as it lives, and a
 * pooled connection would be handed back to the next query and lose the
 * subscription.
 */
function session(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client = new Client({ connectionString: config.databaseUrl });
    active = client;
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (active === client) active = null;
      client.end().catch(() => {
        // Already gone; the reconnect below is the only recovery that matters.
      });
      if (err === undefined) resolve();
      else reject(err);
    };

    client.on('error', finish);
    client.on('end', () => {
      finish();
    });
    client.on('notification', (message) => {
      onNotification(message.payload);
    });

    client
      .connect()
      // The channel name is an internal constant, never user input: `LISTEN`
      // takes an identifier, not a bind parameter, so it has to be interpolated.
      .then(() => client.query(`LISTEN ${SEAT_CHANGES_CHANNEL}`))
      .then(() => {
        console.log(`[listener] listening on "${SEAT_CHANGES_CHANNEL}"`);
      })
      .catch(finish);
  });
}

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      await session();
    } catch (err) {
      console.error('[listener] connection lost', err);
    }
    if (stopping) break;
    await wait(RECONNECT_DELAY_MS);
  }
  running = false;
}

/**
 * Subscribes to `seat_changes` and keeps the subscription alive, reconnecting
 * for as long as the process runs. Returns immediately: the first connection is
 * established in the background, and a client that connects before it is ready
 * still gets its snapshot straight from the database.
 */
export function startListener(): void {
  if (running) return;
  running = true;
  stopping = false;
  void loop();
}

/** Stops listening and drops the connection. Used by tests and shutdown. */
export async function stopListener(): Promise<void> {
  stopping = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (cancelWait !== null) {
    cancelWait();
    cancelWait = null;
  }
  const client = active;
  active = null;
  if (client === null) return;
  try {
    await client.end();
  } catch {
    // Nothing left to close.
  }
}
