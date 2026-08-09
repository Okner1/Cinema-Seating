# Cinema Reservation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-stack cinema seat reservation app — login, live seat map over WebSocket, 15-minute holds with server-validated selection rules, booking by reservation id.

**Architecture:** Express + TypeScript REST API for all mutations; WebSocket (per map instance) for snapshot + deltas driven by Postgres LISTEN/NOTIFY; PostgreSQL as the single source of truth with derived seat status (normalized M:N), whole-row `FOR UPDATE` locking, `clock_timestamp()` expiry discipline, lazy expiry + sweeper. React + Vite frontend with styled-components; nginx serves the frontend and proxies `/api` + WS so cookies are first-party (no CORS in Docker).

**Tech Stack:** pnpm, TypeScript (strict), Express 4, `pg`, `bcrypt`, `jsonwebtoken`, `cookie-parser`, `ws`, Vitest + Supertest; React 18, Vite, react-router-dom, styled-components; Docker Compose (postgres:16, node:20-alpine, nginx:alpine).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-cinema-reservation-design.md` — it wins on any conflict.
- Package manager: **pnpm** everywhere. TS `strict: true`.
- Layout: rows 1–10 have seats 1–10; rows 11–13 have seats 1–5 (115 seats/instance).
- Hold TTL 15 min (`HOLD_MINUTES=15`), heartbeat `HEARTBEAT_MS=5000`, sweeper `SWEEP_INTERVAL_MS=30000` — all env-configurable.
- Every expiry comparison / `expires_at` computation uses `clock_timestamp()`, never `now()`.
- Lock order: reservation row first (if any), then the row's seats via ONE ordered `FOR UPDATE` statement.
- One active `held` group per user per instance. Modifying it resets `expires_at`.
- Password policy (server-side): ≥6 chars, ≥1 upper, ≥1 lower, ≥1 digit. bcrypt cost 10.
- JWT: httpOnly + Secure + SameSite=Lax cookie named `token`, 24 h expiry. Login failures → generic message.
- All backend routes under `/api`; WS at `/api/ws?instanceId=N`.
- Error envelope: `{ "error": string, "code": string }`. Codes: `DIFFERENT_ROWS`, `NOT_CONSECUTIVE`, `TRAPPED_SEAT`, `SEAT_TAKEN`, `ACTIVE_GROUP_EXISTS`, `EXPIRED`, `NOT_FOUND`, `FORBIDDEN`, `INVALID_INPUT`, `INVALID_CREDENTIALS`.
- Integration tests hit a real Postgres from `docker compose up -d db` (`DATABASE_URL=postgres://cinema:cinema@localhost:5432/cinema`).
- Commit after every task (at minimum).

---

### Task 1: Repo scaffold, Postgres in compose, backend toolchain

**Files:**
- Create: `docker-compose.yml`, `.gitignore`, `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`, `backend/src/config.ts`, `backend/.env.example`

**Interfaces:**
- Produces: `config` object `{ port: number; databaseUrl: string; jwtSecret: string; holdMinutes: number; heartbeatMs: number; sweepIntervalMs: number }` from `backend/src/config.ts` (reads `process.env`, defaults: 4000, the compose URL above, `dev-secret-change-me`, 15, 5000, 30000).

- [ ] **Step 1:** Write `docker-compose.yml` with only the `db` service: `postgres:16-alpine`, env `POSTGRES_USER=cinema`, `POSTGRES_PASSWORD=cinema`, `POSTGRES_DB=cinema`, port `5432:5432`, named volume `pgdata`, healthcheck `pg_isready -U cinema`.
- [ ] **Step 2:** Root `.gitignore`: `node_modules/`, `dist/`, `.env`.
- [ ] **Step 3:** `cd backend`; `pnpm init`; `pnpm add express pg bcrypt jsonwebtoken cookie-parser ws` ; `pnpm add -D typescript tsx vitest supertest @types/express @types/pg @types/bcrypt @types/jsonwebtoken @types/cookie-parser @types/ws @types/supertest @types/node`. Scripts: `"dev": "tsx watch src/index.ts"`, `"build": "tsc"`, `"start": "node dist/index.js"`, `"test": "vitest run"`, `"migrate": "tsx src/db/migrate.ts"`.
- [ ] **Step 4:** `tsconfig.json`: `strict`, `target ES2022`, `module NodeNext`, `outDir dist`, `rootDir src`. `vitest.config.ts`: node environment, include `tests/**/*.test.ts`, `fileParallelism: false` (integration tests share one DB).
- [ ] **Step 5:** Write `src/config.ts` exporting the `config` object per the interface above.
- [ ] **Step 6:** Verify: `docker compose up -d db` → healthy; `pnpm tsc --noEmit` passes.
- [ ] **Step 7:** Commit: `chore: scaffold backend toolchain and postgres compose`

### Task 2: Schema, migration runner, idempotent seed

**Files:**
- Create: `backend/src/db/pool.ts`, `backend/src/db/schema.sql`, `backend/src/db/migrate.ts`
- Test: `backend/tests/db.test.ts`

**Interfaces:**
- Produces: `pool: pg.Pool` (from `pool.ts`, built from `config.databaseUrl`); `migrate(): Promise<void>` runs schema + seed, safe to run repeatedly.

- [ ] **Step 1:** `schema.sql` (every statement idempotent):

```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS map_instances (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS seats (
  id SERIAL PRIMARY KEY,
  instance_id INT NOT NULL REFERENCES map_instances(id),
  row_number INT NOT NULL,
  seat_number INT NOT NULL,
  UNIQUE (instance_id, row_number, seat_number)
);
CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  instance_id INT NOT NULL REFERENCES map_instances(id),
  status TEXT NOT NULL CHECK (status IN ('held','booked','expired','released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reservation_seats (
  reservation_id INT NOT NULL REFERENCES reservations(id),
  seat_id INT NOT NULL REFERENCES seats(id),
  PRIMARY KEY (reservation_id, seat_id)
);
CREATE INDEX IF NOT EXISTS idx_resseats_seat ON reservation_seats(seat_id);
CREATE INDEX IF NOT EXISTS idx_res_instance_status ON reservations(instance_id, status);
```

- [ ] **Step 2:** `migrate.ts`: read `schema.sql`, execute; then seed instance `'Main Hall'` (`INSERT ... ON CONFLICT (name) DO NOTHING`), fetch its id, and seed seats with one multi-row `INSERT ... ON CONFLICT DO NOTHING`: rows 1–10 × seats 1–10 plus rows 11–13 × seats 1–5. Runnable as a script (`pnpm migrate`) and importable as `migrate()`.
- [ ] **Step 3:** Test `db.test.ts`: run `migrate()` twice; assert seat count for the instance is exactly 115 (no duplicates), and `SELECT count(*) FROM seats WHERE row_number=11` is 5.
- [ ] **Step 4:** `pnpm test` → PASS. Commit: `feat: schema, migration runner, idempotent seed`

### Task 3: Selection rules module (pure, TDD)

**Files:**
- Create: `backend/src/reservations/rules.ts`
- Test: `backend/tests/rules.test.ts`

**Interfaces:**
- Produces:
  - `isConsecutive(seatNumbers: number[]): boolean` — true iff non-empty and, after sorting, each element is prev+1.
  - `findTrappedSeat(occupiedAfter: { seatNumber: number; occupied: boolean }[]): number | null` — input is the FULL row occupancy AFTER hypothetically applying the selection (selection counts as occupied); returns the trapped seat number, or null. A gap of exactly one empty seat strictly between two occupied seats is trapped; edges are fine.

- [ ] **Step 1:** Write failing tests (all from the PDF's examples plus edges):

```ts
import { describe, it, expect } from 'vitest';
import { isConsecutive, findTrappedSeat } from '../src/reservations/rules.js';

const row = (occ: number[], n = 10) =>
  Array.from({ length: n }, (_, i) => ({ seatNumber: i + 1, occupied: occ.includes(i + 1) }));

describe('isConsecutive', () => {
  it('accepts single seat', () => expect(isConsecutive([5])).toBe(true));
  it('accepts consecutive any order', () => expect(isConsecutive([7, 5, 6])).toBe(true));
  it('rejects gap', () => expect(isConsecutive([5, 7])).toBe(false));
  it('rejects empty', () => expect(isConsecutive([])).toBe(false));
  it('rejects duplicates', () => expect(isConsecutive([5, 5, 6])).toBe(false));
});

describe('findTrappedSeat', () => {
  it('PDF valid: 1,2 booked + select 3,4', () =>
    expect(findTrappedSeat(row([1, 2, 3, 4]))).toBeNull());
  it('PDF invalid: 1,2 booked + select 4,5 traps 3', () =>
    expect(findTrappedSeat(row([1, 2, 4, 5]))).toBe(3));
  it('PDF edge: select 2..10, seat 1 alone at wall is fine', () =>
    expect(findTrappedSeat(row([2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull());
  it('gap of two is fine', () => expect(findTrappedSeat(row([1, 4, 5]))).toBeNull());
  it('trap in middle', () => expect(findTrappedSeat(row([4, 6]))).toBe(5));
  it('empty row fine', () => expect(findTrappedSeat(row([]))).toBeNull());
  it('short row (5 seats) trap', () => expect(findTrappedSeat(row([1, 3], 5))).toBe(2));
});
```

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement:

```ts
export function isConsecutive(seatNumbers: number[]): boolean {
  if (seatNumbers.length === 0) return false;
  const s = [...seatNumbers].sort((a, b) => a - b);
  return s.every((n, i) => i === 0 || n === s[i - 1] + 1);
}

export function findTrappedSeat(
  occupiedAfter: { seatNumber: number; occupied: boolean }[],
): number | null {
  const s = [...occupiedAfter].sort((a, b) => a.seatNumber - b.seatNumber);
  let lastOcc = -1;
  for (let i = 0; i < s.length; i++) {
    if (!s[i].occupied) continue;
    if (lastOcc !== -1 && i - lastOcc === 2) return s[i - 1].seatNumber;
    lastOcc = i;
  }
  return null;
}
```

- [ ] **Step 4:** `pnpm test` → PASS. Commit: `feat: selection rules (consecutive, trapped-seat)`

### Task 4: Auth (register, login, me, guard)

**Files:**
- Create: `backend/src/auth/password.ts`, `backend/src/auth/jwt.ts`, `backend/src/auth/middleware.ts`, `backend/src/auth/routes.ts`, `backend/src/app.ts`
- Test: `backend/tests/auth.test.ts`

**Interfaces:**
- Produces:
  - `validatePasswordPolicy(pw: string): string | null` (error message or null).
  - `signToken(userId: number): string` / `verifyToken(token: string): { userId: number } | null`.
  - `requireAuth` Express middleware → sets `req.userId: number` (augment Express.Request via declaration merge) or responds 401.
  - `createApp(): express.Express` in `app.ts` — json body parser, cookie-parser, mounts `/api/auth` (and later routers). `index.ts` stays separate (Task 9).
  - Routes: `POST /api/auth/register {username, password}` → 201 `{id, username}` + sets cookie (auto-login); 409 username taken; 400 policy/`INVALID_INPUT`. `POST /api/auth/login` → 200 `{id, username}` + cookie; 401 `INVALID_CREDENTIALS` (same body whether user exists or not). `GET /api/auth/me` (guarded) → `{id, username}`. `POST /api/auth/logout` → clears cookie.

- [ ] **Step 1:** Failing tests (supertest against `createApp()`, DB truncated in `beforeEach` via `TRUNCATE users, reservations, reservation_seats RESTART IDENTITY CASCADE`): register happy path sets `Set-Cookie` with `HttpOnly`; register rejects `abc`, `alllower1`, `ALLUPPER1`, `NoDigits` (400); duplicate username → 409; login wrong password → 401 with same body as unknown user; `/me` with cookie → 200, without → 401.
- [ ] **Step 2:** Run → FAIL. Implement password.ts (regex checks + bcrypt hash/compare), jwt.ts (`jsonwebtoken`, 24h), middleware, routes; cookie options `{ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 24*3600*1000 }`. Note: `secure: true` cookies are accepted on localhost by browsers; supertest sees the header regardless.
- [ ] **Step 3:** `pnpm test` → PASS. Commit: `feat: auth with bcrypt, jwt cookie, policy`

### Task 5: Instances route + snapshot query

**Files:**
- Create: `backend/src/instances/routes.ts`, `backend/src/realtime/snapshot.ts`
- Modify: `backend/src/app.ts` (mount `/api/map-instances`)
- Test: `backend/tests/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/map-instances` (guarded) → `[{id, name}]`.
  - `type SeatView = { id: number; row: number; number: number; status: 'available'|'reserved'|'booked'; userId: number | null; expiresAt: string | null }`
  - `getSnapshot(instanceId: number): Promise<SeatView[]>` — one query, lazy expiry:

```sql
SELECT s.id, s.row_number AS row, s.seat_number AS number,
       r.status AS r_status, r.user_id, r.expires_at
FROM seats s
LEFT JOIN reservation_seats rs ON rs.seat_id = s.id
LEFT JOIN reservations r ON r.id = rs.reservation_id
  AND (r.status = 'booked' OR (r.status = 'held' AND r.expires_at > clock_timestamp()))
WHERE s.instance_id = $1
ORDER BY s.row_number, s.seat_number;
```

  Collapse duplicate seat rows (a seat may join old inactive reservations as NULL — the join condition already filters; still guard by taking the non-null match per seat id). Map: `booked`→'booked', `held`→'reserved', none→'available'.

- [ ] **Step 1:** Failing test: seed via `migrate()`; insert a `held` reservation (expires +15 min) on seats (1,1)+(1,2) and an already-expired `held` on (2,1); assert snapshot marks (1,1) reserved with userId+expiresAt, (2,1) available, count 115.
- [ ] **Step 2:** Implement; run → PASS. Commit: `feat: instance list and seat snapshot with lazy expiry`

### Task 6: Reserve transaction (POST /api/reservations)

**Files:**
- Create: `backend/src/reservations/service.ts`, `backend/src/reservations/routes.ts`
- Modify: `backend/src/app.ts` (mount `/api/reservations`)
- Test: `backend/tests/reserve.test.ts`, `backend/tests/concurrency.test.ts`

**Interfaces:**
- Produces:
  - `class DomainError extends Error { constructor(public code: string, public httpStatus: number, msg: string) }`
  - `reserve(userId: number, instanceId: number, seatIds: number[]): Promise<{ reservationId: number; expiresAt: string; seatIds: number[] }>`
  - Route `POST /api/reservations` (guarded) body `{instanceId, seatIds}` → 201 or DomainError mapped to `{error, code}` with its status.
  - `notifySeatChanges(client, instanceId, reservationId)` — helper that runs inside the txn: `SELECT pg_notify('seat_changes', $1)` with JSON `{instanceId, reservationId}` (listener re-derives seat states in Task 9; payload stays tiny under the 8KB limit).

- [ ] **Step 1:** Failing unit-flow tests for `reserve()` (real DB):
  - happy path: returns id + expiresAt ≈ now+15min; reservation status `held`; junction rows exist.
  - seats from different rows → `DIFFERENT_ROWS` 400 (checked BEFORE any lock: `SELECT ... WHERE id = ANY($1)` then compare `row_number`s; also unknown seat id / wrong instance → `NOT_FOUND` 404; empty array → `INVALID_INPUT` 400).
  - non-consecutive → `NOT_CONSECUTIVE` 400 (pure check, pre-lock).
  - overlapping an active hold → `SEAT_TAKEN` 409; overlapping an EXPIRED hold → succeeds (lazy expiry).
  - would trap a single seat (occupied {1,2}, select {4,5}) → `TRAPPED_SEAT` 400.
  - second POST while user already has an active held group in this instance → `ACTIVE_GROUP_EXISTS` 409.
- [ ] **Step 2:** Implement `reserve()`:

```ts
// inside pool.connect() client, try/finally release
await client.query('BEGIN');
// guard: one active group per user+instance (no lock needed; row lock below serializes rivals)
// SELECT id FROM reservations WHERE user_id=$1 AND instance_id=$2 AND status='held'
//   AND expires_at > clock_timestamp()  → if found: DomainError ACTIVE_GROUP_EXISTS
const locked = await client.query(
  `SELECT s.id, s.seat_number,
     EXISTS (SELECT 1 FROM reservation_seats rs
             JOIN reservations r ON r.id = rs.reservation_id
             WHERE rs.seat_id = s.id
               AND (r.status='booked' OR (r.status='held' AND r.expires_at > clock_timestamp()))
     ) AS occupied
   FROM seats s
   WHERE s.instance_id = $1 AND s.row_number = $2
   ORDER BY s.seat_number
   FOR UPDATE OF s`, [instanceId, rowNumber]);
// selected seats must all be !occupied → else SEAT_TAKEN
// build occupiedAfter = locked rows with (occupied || selected) → findTrappedSeat → TRAPPED_SEAT
// INSERT reservations (status 'held', expires_at = clock_timestamp() + ($3 || ' minutes')::interval) RETURNING id, expires_at
// INSERT reservation_seats (multi-row)
// notifySeatChanges(client, instanceId, reservationId)
await client.query('COMMIT');
```

  On DomainError: `ROLLBACK`, rethrow. Same-row/consecutive checks happen before `BEGIN`.
- [ ] **Step 3:** Concurrency tests (`concurrency.test.ts`, two dedicated `pg.Client`s):
  - **Double-hold race:** run `reserve(userA, seats {3,4})` and `reserve(userB, seats {3,4})` via `Promise.allSettled` — exactly one fulfilled, one rejected `SEAT_TAKEN`.
  - **Joint trap race:** empty row; A reserves {1,2}, B reserves {4,5} concurrently — exactly one fulfilled, the other rejected `TRAPPED_SEAT` (this proves whole-row locking; per-seat locking would let both pass).
- [ ] **Step 4:** All tests PASS. Commit: `feat: reserve transaction with row lock and rule validation`

### Task 7: Modify group (PATCH) and release (DELETE)

**Files:**
- Modify: `backend/src/reservations/service.ts`, `backend/src/reservations/routes.ts`
- Test: `backend/tests/modify.test.ts`

**Interfaces:**
- Produces:
  - `modifyReservation(userId, reservationId, seatIds: number[]): Promise<{reservationId, expiresAt, seatIds}>` — seatIds is the FULL desired set (client sends complete new selection). Empty set is `INVALID_INPUT` (client uses DELETE instead).
  - `releaseReservation(userId, reservationId): Promise<void>`
  - Routes: `PATCH /api/reservations/:id/seats {seatIds}` → 200; `DELETE /api/reservations/:id` → 204. Not owner → `FORBIDDEN` 403; not `held` or expired → `EXPIRED` 410; unknown id → `NOT_FOUND` 404.

- [ ] **Step 1:** Failing tests: extend {3,4}→{3,4,5} succeeds and RESETS expiry (assert new expiresAt > old); shrink {3,4,5}→{3,4} succeeds; desired set in a different row than current group → `DIFFERENT_ROWS` 400; modify after manual `UPDATE reservations SET expires_at = clock_timestamp() - interval '1 second'` → 410; other user's reservation → 403; release flips status to `released` and seats show available in snapshot.
- [ ] **Step 2:** Implement — lock order per Global Constraints: `SELECT * FROM reservations WHERE id=$1 FOR UPDATE` (check owner/status/expiry with `clock_timestamp()`), then the same ordered whole-row seat lock as Task 6, occupancy computed EXCLUDING this reservation's own seats, validate new set (consecutive pre-checked before BEGIN), `DELETE FROM reservation_seats WHERE reservation_id=$1` + re-insert, `UPDATE reservations SET expires_at = clock_timestamp() + interval` , notify, commit. `releaseReservation`: lock reservation row, verify, `UPDATE ... SET status='released'`, notify, commit (no seat locks needed — releasing only frees seats).
- [ ] **Step 3:** PASS. Commit: `feat: modify and release held group`

### Task 8: Book (POST /api/reservations/:id/book)

**Files:**
- Modify: `backend/src/reservations/service.ts`, `backend/src/reservations/routes.ts`
- Test: `backend/tests/book.test.ts`

**Interfaces:**
- Produces: `bookReservation(userId, reservationId): Promise<{reservationId, status: 'booked'}>`; route → 200; expired → `EXPIRED` 410; not owner → 403; already booked → `EXPIRED`? No — booking an already-`booked` group returns 200 idempotently (safe double-click).

- [ ] **Step 1:** Failing tests: happy path flips to `booked`, snapshot shows `booked`; expired hold → 410; idempotent re-book → 200; **the stale-clock race test**: open manual txn A that locks the row's seats (simulating a concurrent reserve), start `bookReservation` for a hold that expires in 300ms, make txn A sleep 500ms then insert a new held group on those seats (as the lazy-expiry winner) and commit — assert book rejects with `EXPIRED` (this passes only because book uses `clock_timestamp()` after acquiring seat locks; `now()` would double-claim).
- [ ] **Step 2:** Implement with the mandated lock order: reservation row `FOR UPDATE` (owner + status checks) → whole-row seat lock (same statement as reserve) → `expires_at > clock_timestamp()` check → `UPDATE reservations SET status='booked'` → notify → commit.
- [ ] **Step 3:** PASS. Commit: `feat: book reservation with seat-lock serialization and wall-clock expiry`

### Task 9: Realtime — hub, LISTEN/NOTIFY, WS server, heartbeat/seq, sweeper, bootstrap

**Files:**
- Create: `backend/src/realtime/hub.ts`, `backend/src/realtime/listener.ts`, `backend/src/realtime/wsServer.ts`, `backend/src/reservations/sweeper.ts`, `backend/src/index.ts`
- Test: `backend/tests/realtime.test.ts`

**Interfaces:**
- Produces (message protocol, JSON over WS):
  - Server→client: `{type:'snapshot', seq: number, seats: SeatView[]}` · `{type:'delta', seq, seats: SeatView[]}` (implementation sends the full recomputed `getSnapshot(instanceId)` list as the delta payload — 115 seats is tiny; simplicity over minimal diffs) · `{type:'ping', seq}`
  - Client→server: `{type:'pong'}` · `{type:'sync'}` (→ server replies with fresh snapshot)
  - Personalization: `SeatView.userId` is replaced per-socket by `mine: boolean` before send (`{...seat, mine: seat.userId === socket.userId, userId: undefined}`).
  - `hub.join(instanceId, socket)`, `hub.broadcast(instanceId, seats: SeatView[])` (increments per-instance seq), `hub.currentSeq(instanceId)`.
  - `startListener()`: dedicated `pg.Client` (NOT from the pool), `LISTEN seat_changes`; on notification parse `{instanceId}` → `getSnapshot(instanceId)` → `hub.broadcast`. On listener connection error: reconnect with 1s backoff (clients self-heal via seq gap anyway).
  - `startSweeper()`: `setInterval(sweepIntervalMs)`: one txn — `UPDATE reservations SET status='expired' WHERE status='held' AND expires_at <= clock_timestamp() RETURNING instance_id` → `pg_notify` once per distinct instance.
  - `wsServer`: HTTP `upgrade` on path `/api/ws` — parse cookie, `verifyToken`, parse `instanceId`, reject 401/400 otherwise; on connect: join + send snapshot with current seq; ping loop every `heartbeatMs` sending `{type:'ping', seq}`; terminate socket after 2 missed pongs.
  - `index.ts`: `migrate()` → `createApp()` → `http.createServer(app)` → attach wsServer → `startListener()` → `startSweeper()` → listen on `config.port`.

- [ ] **Step 1:** Failing integration test (`ws` package as client): register+login via supertest to get cookie → open WS with cookie header → expect snapshot (115 seats, seq N) → call `reserve()` directly → expect a delta whose seats include the reserved ones with `status:'reserved'` and seq N+1 → send `{type:'sync'}` → expect fresh snapshot same seq. Second test: connection without cookie is refused.
- [ ] **Step 2:** Implement hub/listener/wsServer/sweeper/index per interfaces.
- [ ] **Step 3:** PASS. Manual smoke: `pnpm dev`, connect twice from two terminals (`npx wscat` with cookie), reserve via curl, watch both get the delta. Commit: `feat: websocket realtime layer with listen/notify, seq, heartbeat, sweeper`

### Task 10: Frontend scaffold + auth pages

**Files:**
- Create: `frontend/` via `pnpm create vite frontend --template react-ts`; then `frontend/src/App.tsx`, `frontend/src/api.ts`, `frontend/src/pages/LoginPage.tsx`, `frontend/src/auth.tsx`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Produces:
  - `api<T>(path, opts): Promise<T>` — `fetch('/api'+path, { credentials: 'include', headers: {'Content-Type':'application/json'}, ...opts })`; non-2xx → throws `ApiError {code, message, status}` parsed from the error envelope.
  - `useAuth()` context: `{ user: {id, username} | null, loading, login(u,p), register(u,p), logout() }` — bootstraps by calling `/auth/me` on mount.
  - Routes: `/login` (LoginPage), `/` (MapPage, Task 11–12) wrapped in `<RequireAuth>` that redirects to `/login` when `user === null && !loading`.
  - `vite.config.ts` dev proxy: `/api` → `http://localhost:4000` (with `ws: true`) so cookies are first-party in dev too.

- [ ] **Step 1:** Scaffold; `pnpm add styled-components react-router-dom`.
- [ ] **Step 2:** Implement api.ts, auth context, LoginPage: two fields + Login and Register buttons (register calls register endpoint then lands on `/`); inline error text from `ApiError.message`; minimal styled-components styling.
- [ ] **Step 3:** Verify manually: register → redirected to `/` (blank map page placeholder is fine at this task); refresh keeps session; wrong password shows generic error. Commit: `feat: frontend scaffold, auth flow`

### Task 11: WS hook + connection overlay

**Files:**
- Create: `frontend/src/map/useSeatMap.ts`, `frontend/src/map/Overlay.tsx`, `frontend/src/pages/MapPage.tsx` (instance picker + wiring)

**Interfaces:**
- Produces:
  - `type Seat = { id: number; row: number; number: number; status: 'available'|'reserved'|'booked'; mine: boolean; expiresAt: string | null }`
  - `useSeatMap(instanceId: number | null): { seats: Map<number, Seat>; conn: 'connecting'|'open'|'reconnecting'|'failed'; attempt: number; retryNow(): void }`
  - Behavior: opens `ws(s)://location.host/api/ws?instanceId=N`; handles `snapshot` (replace map, set lastSeq), `delta` (apply if `seq === lastSeq+1` else send `{type:'sync'}`), `ping` (reply pong; if `seq !== lastSeq` send sync; also reset a 2×HEARTBEAT watchdog timer — if it fires, treat as dead: close + reconnect). Reconnect backoff [1s,2s,4s,8s,16s]; after 5 failures → `failed` (manual `retryNow` resets). Cleanup on unmount/instance change.
  - `Overlay`: rendered over the map area when `conn !== 'open'`; frosted glass (`backdrop-filter: blur(8px)`, translucent background); texts: connecting → "Connecting…", reconnecting → "Connection lost — attempting to reconnect (attempt N)…", failed → "Unable to reconnect automatically. Please wait a few minutes and try again." + Retry button.
  - MapPage: fetches `/map-instances` (REST) into a `<select>`; renders children grid (Task 12) only when an instance is chosen; overlay covers the grid per `conn`.

- [ ] **Step 1:** Implement hook + overlay + picker.
- [ ] **Step 2:** Manual verification (this task is glue around browser APIs — manual test is the honest test): open map → snapshot renders count in console; kill backend → overlay appears within ~10s (watchdog) or instantly (clean close); restart backend → auto-reconnects and re-snapshots; after 5 fails → manual state. Commit: `feat: seat map websocket hook with reconnect overlay`

### Task 12: Seat grid, selection mechanics, reserve/book wiring, countdown

**Files:**
- Create: `frontend/src/map/SeatGrid.tsx`, `frontend/src/map/Seat.tsx`, `frontend/src/map/selection.ts`, `frontend/src/map/ReservationBar.tsx`
- Modify: `frontend/src/pages/MapPage.tsx`
- Test: `frontend/src/map/selection.test.ts` (add `vitest` to frontend devDeps)

**Interfaces:**
- Produces:
  - `computeDragRange(anchor: Seat, cursor: Seat, rowSeats: Seat[]): number[]` (pure): if `cursor.row !== anchor.row` → range so far unchanged (drag is confined to anchor row); walk from anchor.number toward cursor.number, stop before the first seat that is occupied (`status !== 'available'` and not `mine`); return seat ids in the walked range.
  - `MyReservation = { id: number; seatIds: number[]; expiresAt: string } | null` held in MapPage state; updated from every mutation response; cleared when countdown hits 0 or on `EXPIRED` errors.
  - Interactions (MapPage handlers calling `api`):
    - mousedown on available seat → begin drag (anchor); mouseenter recomputes range via `computeDragRange`; mouseup → desired = `myReservation ? union(myReservation.seatIds, range) : range` → POST `/reservations` or PATCH `/reservations/:id/seats`; server errors → toast the `error` message (backend is the only validator).
    - click on a `mine` seat → desired = current minus that seat → PATCH, or DELETE when it empties.
    - Reset button → DELETE; Book button → POST `/reservations/:id/book`; both disabled when no reservation.
  - `Seat.tsx`: styled circle (~34px, border-radius 50%), colors: available gray, reserved orange, booked red, mine green, drag-preview blue outline. Rows rendered as flex lines with gaps; rows 11–13 centered (`justify-content: center`).
  - `ReservationBar`: shows countdown `mm:ss` from `expiresAt` (interval tick 1s; clock skew handled by trusting server timestamp vs `Date.now()` — acceptable, noted), Book + Reset buttons, error toast area.

- [ ] **Step 1:** Write failing tests for `computeDragRange`: extends right, extends left, clamps at reserved seat, ignores cursor in other row, single-seat range on anchor==cursor. Run → FAIL.
- [ ] **Step 2:** Implement `selection.ts` → tests PASS.
- [ ] **Step 3:** Implement components + wiring.
- [ ] **Step 4:** Manual two-browser verification: reserve in browser A → turns orange in B live; A's trapped-seat attempt shows server error; countdown expires → seats free in both (sweeper broadcast ≤30s); Book flips green→red in B. Commit: `feat: seat grid with drag selection, hold countdown, booking`

### Task 13: Docker full stack, README, ERD placeholder

**Files:**
- Create: `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`, `README.md`, `docs/erd/` (final image added by hand)
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `docker compose up --build` → app at `http://localhost:8080`, API proxied at `/api`, WS at `/api/ws`, everything first-party (no CORS).

- [ ] **Step 1:** `backend/Dockerfile`: node:20-alpine, pnpm via corepack, install, build, `CMD ["node","dist/index.js"]` (migrate runs at boot via index.ts). `frontend/Dockerfile`: build stage → nginx:alpine with `nginx.conf`: serve `dist/`, `location /api { proxy_pass http://backend:4000; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_http_version 1.1; }`, SPA fallback `try_files $uri /index.html`.
- [ ] **Step 2:** Compose: add `backend` (env `DATABASE_URL=postgres://cinema:cinema@db:5432/cinema`, `JWT_SECRET`, depends_on db healthy) and `frontend` (port `8080:80`, depends_on backend).
- [ ] **Step 3:** Verify from scratch: `docker compose down -v && docker compose up --build` → register, reserve in two browsers, book, kill backend container → overlay, restart → recovery.
- [ ] **Step 4:** README: what it is, stack, one-command run, dev-mode run, API table, WS protocol, and a **Design Decisions** section lifted from the spec's decisions record (row locking, clock_timestamp, LISTEN/NOTIFY vs Redis/outbox, lazy expiry + sweeper, seq/heartbeat resync, normalized M:N, 5s heartbeat). Link the ERD image at `docs/erd/erd.png` (drawn externally from the spec's 5-entity diagram; commit the image before submission).
- [ ] **Step 5:** Commit: `feat: dockerized full stack with nginx proxy and README`

---

## Verification checklist (post-plan, before submission)

- [ ] `docker compose up --build` from a clean clone works first try.
- [ ] All backend tests green (`pnpm test` with db up).
- [ ] Two-browser live-update demo works; kill/restart backend demo works.
- [ ] PDF requirements walk-through: auth ✓, map ✓, statuses ✓, layout ✓, 15-min hold ✓, auto-release ✓, no double-hold ✓, Rule 1 server-side ✓, Rule 2 server-side ✓, React ✓, Node+TS ✓, Postgres ✓, Docker ✓, README ✓, ERD image committed ✓.
