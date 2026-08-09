import { useCallback, useEffect, useState } from 'react';

/** Server ping interval (fixed by the backend contract). */
export const HEARTBEAT_MS = 5000;

/** Delay before reconnect attempt N (1-based). Exhausting the list means giving up. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export type SeatStatus = 'available' | 'reserved' | 'booked';

export interface Seat {
  id: number;
  row: number;
  number: number;
  status: SeatStatus;
  mine: boolean;
  expiresAt: string | null;
}

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface SeatMapState {
  /** Seats keyed by id. Replaced wholesale on every snapshot. */
  seats: Map<number, Seat>;
  conn: ConnState;
  /** Which reconnect attempt is in flight (0 while connected or before the first drop). */
  attempt: number;
  /** Start over after `conn === 'failed'`. */
  retryNow: () => void;
}

type ServerMessage =
  | { type: 'snapshot'; seq: number; seats: Seat[] }
  | { type: 'delta'; seq: number; seats: Seat[] }
  | { type: 'ping'; seq: number };

function parseMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data) as ServerMessage | null;
    if (msg === null || typeof msg !== 'object') return null;
    if (msg.type === 'snapshot' || msg.type === 'delta' || msg.type === 'ping') return msg;
    return null;
  } catch {
    return null;
  }
}

/** Silence a socket and close it — no further callbacks can reach us. */
function detach(ws: WebSocket): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  ws.close();
}

function socketUrl(instanceId: number): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/ws?instanceId=${instanceId}`;
}

/**
 * Live seat map for one map instance.
 *
 * Owns a single websocket: applies `snapshot`/`delta` messages, answers `ping`
 * with `pong`, asks for a fresh snapshot (`sync`) whenever sequence numbers show
 * we missed something, and watches for a silent server (no ping within
 * 2×HEARTBEAT) so a half-open socket still counts as a disconnect. Drops are
 * retried with a fixed backoff; once the backoff list is exhausted the hook
 * parks in `failed` until `retryNow()`.
 */
export function useSeatMap(instanceId: number | null): SeatMapState {
  const [seats, setSeats] = useState<Map<number, Seat>>(() => new Map());
  const [conn, setConn] = useState<ConnState>('connecting');
  const [attempt, setAttempt] = useState(0);
  // Bumping this re-runs the effect below, which is exactly "start over".
  const [retryToken, setRetryToken] = useState(0);
  const retryNow = useCallback(() => setRetryToken((t) => t + 1), []);

  useEffect(() => {
    setSeats(new Map());
    setConn('connecting');
    setAttempt(0);
    if (instanceId === null) return;

    const url = socketUrl(instanceId);
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    /** Consecutive failed connections; reset by a successful open. */
    let failures = 0;
    /** Sequence number of the last message we accepted (-1 until the first snapshot). */
    let lastSeq = -1;

    const scheduleReconnect = () => {
      failures += 1;
      const delay = BACKOFF_MS[failures - 1];
      if (delay === undefined) {
        setConn('failed');
        return;
      }
      setConn('reconnecting');
      setAttempt(failures);
      reconnectTimer = setTimeout(connect, delay);
    };

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(url);
      socket = ws;

      let handled = false;

      /** Single funnel for "this socket is done", however we found out. */
      const down = () => {
        if (handled) return;
        handled = true;
        clearTimeout(watchdogTimer);
        detach(ws);
        if (socket === ws) socket = null;
        if (!disposed) scheduleReconnect();
      };

      const armWatchdog = () => {
        clearTimeout(watchdogTimer);
        // No ping within two heartbeats: the socket may be open but the peer is gone.
        watchdogTimer = setTimeout(down, 2 * HEARTBEAT_MS);
      };

      const send = (msg: { type: 'pong' | 'sync' }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      };

      ws.onopen = () => {
        failures = 0;
        lastSeq = -1;
        setConn('open');
        setAttempt(0);
        armWatchdog();
      };

      ws.onmessage = (ev: MessageEvent) => {
        const msg = parseMessage(ev.data);
        if (msg === null) return;

        if (msg.type === 'snapshot') {
          lastSeq = msg.seq;
          setSeats(new Map(msg.seats.map((seat) => [seat.id, seat])));
          return;
        }

        if (msg.type === 'delta') {
          if (msg.seq !== lastSeq + 1) {
            // Gap: our view is stale, so ask for a fresh snapshot instead of guessing.
            send({ type: 'sync' });
            return;
          }
          lastSeq = msg.seq;
          setSeats((prev) => {
            const next = new Map(prev);
            for (const seat of msg.seats) next.set(seat.id, seat);
            return next;
          });
          return;
        }

        // ping — prove we are alive, and catch up if the server moved past us.
        send({ type: 'pong' });
        if (msg.seq !== lastSeq) send({ type: 'sync' });
        armWatchdog();
      };

      ws.onerror = down;
      ws.onclose = down;
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(watchdogTimer);
      if (socket !== null) {
        detach(socket);
        socket = null;
      }
    };
  }, [instanceId, retryToken]);

  return { seats, conn, attempt, retryNow };
}
