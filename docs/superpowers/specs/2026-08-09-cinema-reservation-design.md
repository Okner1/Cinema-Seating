# Cinema Reservation System — Design

Fireberry full-stack home assignment. Authenticated users view a live seating map, hold seats for 15 minutes, and complete bookings. Stack: React + TypeScript (pnpm), Express + TypeScript, PostgreSQL, Docker Compose.

## 1. Frontend

**Stack:** React + TypeScript, pnpm, styled-components, router in `App.tsx`.

**Pages:**
1. **Login / Register** — username + password fields; register adds a register button. Password policy mirrored client-side for UX only (server is authoritative).
2. **Seat map** — picker for the map instance (from `GET /map-instances`), then the seating map for the chosen instance.

**Map rendering:**
- 10 rows × 10 seats, then 3 rows × 5 seats centered.
- Each seat is a circular div (border-radius 50%) with gaps, styled-components.
- Rendered **only** when authenticated and the WebSocket is connected.
- Seat visual states: available · reserved (others) · booked · my-reserved · my-selected.
- Countdown timer on my held seats, driven by the server's `expires_at` timestamp (client computes remaining time). On expiry the seats flip live and the stale selection clears with a notification.

**Selection mechanics:**
- Click a seat to select; drag to select a range within one row.
- Drag is **anchored to the first seat's row** — the range is computed anchor → cursor (never by enumerating hovered seats), so it is consecutive by construction.
- The range **clamps at the first occupied seat** — it never skips over Reserved/Booked seats.
- Deselect: click a selected seat (server validates the remainder and returns an error if it breaks the rules) or a **Reset** button that releases everything.

**Connection resilience:**
- Heartbeat every **5 s** (configurable). Two missed beats → connection considered dead.
- On disconnect: glass (frosted, semi-transparent) overlay blocks the map, shows "attempting to reconnect", auto-retries. After N failures: "unable to reconnect automatically, please wait a few minutes" + manual retry button.
- Every (re)connect receives a **full snapshot**, then deltas. Backend errors surface on the overlay.
- Each delta carries a per-instance **sequence number**; the heartbeat carries the current seq. A gap → client requests a fresh snapshot.

**Auth on the client:** JWT lives in an httpOnly cookie (set by the server); the map page is route-guarded (unauthenticated → redirect to login).

## 2. Backend

**Stack:** Express + TypeScript. Single process for the assignment; broadcast goes through one function so a multi-instance transport swap is localized.

### Auth
- `POST /auth/register`, `POST /auth/login` (POST because credentials must never appear in URLs/logs, and both are state-changing).
- Passwords hashed with **bcrypt**. Policy enforced server-side: ≥ 6 chars, ≥ 1 uppercase, ≥ 1 lowercase, ≥ 1 digit.
- Login failure returns generic "invalid credentials" (no username-exists oracle).
- JWT in an **httpOnly, Secure, SameSite=Lax** cookie, ~24 h lifetime, no refresh token. CORS with `credentials: true`. CSRF mitigated by SameSite.
- The WS handshake is authenticated by the same cookie; auth is checked at handshake time only (accepted trade-off, documented).

### REST API (mutations + metadata)
- `GET /map-instances` → `[{id, name}]` (metadata only; seat state never comes from REST).
- `POST /reservations` — body: instance id + array of seat identifiers. Creates a **held** reservation group, returns `{reservationId, expiresAt}`.
- `PATCH /reservations/:id/seats` (or equivalent) — add or remove seats from the held group; the server re-validates the resulting set as a whole (same row, consecutive, Rule 2).
- **One active held group per user per instance.** The first selection creates the group (POST); every later click/drag-end modifies it (PATCH) until it is booked, released, or expires. Since Rule 1 requires one row per group, extending into a different row is invalid — the client prevents it, the server rejects it. Modifying the group resets `expires_at` to now() + 15 min.
- `DELETE /reservations/:id` — release the whole group (Reset).
- `POST /reservations/:id/book` — flips the exact held group to booked.

Mutations are REST (not WS) because HTTP gives request/response correlation, status codes, error bodies, middleware (auth/validation), and curl-testability for free; the WS carries only server → client events.

### Reservation transaction (the core)
1. **Pre-DB validation (cheap, fail fast):** non-empty array, all seats in the same row, seat numbers consecutive after sorting. No group-size cap (row length caps it naturally).
2. `BEGIN` → `SELECT ... FOR UPDATE` on **all seats of that row in that instance**, in a single statement ordered by seat number (consistent order → no deadlocks). Locking the whole row is required because Rule 2 depends on neighbor seats outside the selection; locking only selected seats allows two concurrent valid-alone holds to jointly trap a single empty seat.
3. Compute row occupancy with **lazy expiry**: a seat is occupied iff it belongs to a `booked` reservation or a `held` reservation with `expires_at > clock_timestamp()`.
4. Validate availability + Rule 1 (consecutive, same row) + Rule 2 (no single empty seat trapped between occupied seats; single empty seat at row edge is fine).
5. Insert `reservations` (status `held`, `expires_at = clock_timestamp() + 15 min`) + `reservation_seats` rows → `COMMIT`.
6. On commit, `NOTIFY` fires (see below) and the response returns `{reservationId, expiresAt}`.

**Timestamp discipline — `clock_timestamp()`, never `now()`:** `now()`/`CURRENT_TIMESTAMP` are frozen at transaction start; a transaction that waited on a `FOR UPDATE` lock re-reads fresh data (READ COMMITTED re-evaluates after lock waits) but would compare it against a stale clock. On the reserve side that is merely conservative (an expired hold counts as occupied a moment longer). On the book side it is a correctness bug: a book transaction that began before a hold's expiry and waited out a lock could book an expired group that another user has meanwhile legitimately re-reserved — a double claim. All expiry comparisons and `expires_at` computations therefore use `clock_timestamp()` (wall clock at evaluation time).

**Book:** transaction — lock the reservation row (verify owner, status `held`), **then lock the row's seats with the same ordered `FOR UPDATE` statement reserve uses**, then check `expires_at > clock_timestamp()` and flip to `booked`. The seat locks are load-bearing: without them, book (reservation lock only) and a concurrent reserve (seat locks only) hold disjoint locks and can interleave — an expired-then-re-reserved group could still be booked. With them, book and reserve on the same row serialize, and the loser sees the winner's committed state. Booking by **reservationId** guarantees the user books exactly the group they held; group expiry is atomic (no per-seat drift).

**Lock-ordering rule (deadlock freedom):** any transaction touching both lock types acquires the **reservation row first, then the row's seats** (seats always via the single ordered statement). Book and PATCH-modify follow this order; POST-reserve locks seats only (no reservation exists yet); the sweeper locks reservation rows only. No ordering cycle exists, so no deadlocks.

**Expiry:** lazy expiry in every query is the source of truth; a background **sweeper** periodically flips expired `held` reservations to `expired` and broadcasts the freed seats so watching clients see them open without acting.

### Real-time layer
- WS endpoint scoped per instance (`/ws?instanceId=42`); server keeps a room per instance (`Map<instanceId, Set<socket>>`).
- On connect: validate auth + instance, join room, send **full snapshot** (all seats with computed status + my active holds with `expires_at`).
- After commit, mutations publish via **Postgres LISTEN/NOTIFY**: `NOTIFY` inside the transaction is delivered only on commit (atomic with the write — no dual-write gap, no outbox needed). A dedicated long-lived listen connection (outside the pool; incompatible with transaction-mode poolers) receives and fans out to local room sockets.
- Every delta carries a monotonically increasing per-instance **seq**; the 5 s heartbeat piggybacks the current seq. Lost notifications are self-healing: gap detection → snapshot resync, bounded staleness ≈ one heartbeat interval.
- Deltas are ephemeral hints; Postgres is the only source of truth. Correctness never depends on broadcast delivery (validation happens in the row-locked transaction).
- Scale path (documented, not built): multiple backend processes all LISTEN on the same channel — fan-out works unchanged; beyond that, Redis pub/sub or a managed channel service (à la seats.io on Ably), still without an outbox because the events are ephemeral.

## 3. Database (PostgreSQL)

Normalized, Option B: seats are pure geometry; seat status is **derived** from reservations — one source of truth, expiry needs no row flips, full history retained.

| Table | Columns | Constraints |
|---|---|---|
| users | id PK, username, password_hash, created_at | UNIQUE(username) |
| map_instances | id PK, name, created_at | |
| seats | id PK, instance_id FK, row_number, seat_number | UNIQUE(instance_id, row_number, seat_number) |
| reservations | id PK, user_id FK, instance_id FK, status, expires_at, created_at | status CHECK: held / booked / expired / released |
| reservation_seats | reservation_id FK, seat_id FK | PK(reservation_id, seat_id) |

**Derived seat status:** booked if in a `booked` reservation; reserved if in a `held` reservation with `expires_at > now()`; else available.

**Indexes:** `reservation_seats(seat_id)` (the PK only covers the reservation → seats direction), `reservations(instance_id, status)`.

**Invariant note (defend onsite):** "one active reservation per seat" spans the join to the parent's status, so no simple unique constraint can enforce it; it is guaranteed by serializing every seat mutation of a physical row through the `FOR UPDATE` row lock. Deliberate trade: derived truth + serialized writes over denormalized state + constraint.

**Seeding:** idempotent (`ON CONFLICT DO NOTHING` against the seats UNIQUE); creates at least one instance with the exact required layout — rows 1–10 with seats 1–10, rows 11–13 with seats 1–5.

**ERD (deliverable, drawn externally, committed as an image):** 5 entities, 5 one-to-many relationships:
users 1—\* reservations, map_instances 1—\* reservations, map_instances 1—\* seats, reservations 1—\* reservation_seats, seats 1—\* reservation_seats. Mark the seats UNIQUE and the reservation_seats composite PK on the diagram.

## 4. Infrastructure & deliverables

- **docker-compose**: postgres + backend + frontend; single command local run.
- **README**: setup/run instructions, architecture overview, key decisions (locking strategy, LISTEN/NOTIFY over Redis/outbox with reasoning, lazy expiry + sweeper, heartbeat/seq resync, join-table normalization), scale path.
- **ERD** image committed to the repo.
- **No CI** (explicit decision).

## Key decisions record (for onsite defense)

1. **Hold-on-reserve, group entity** — BOOK by reservationId books exactly what was held; group expires atomically.
2. **Whole-row `FOR UPDATE` locking** — Rule 2 reads neighbors; per-seat locking admits a concurrent trap of a single empty seat. Rows serialize independently → per-row concurrency is the scale unit.
3. **Lazy expiry + sweeper** — queries treat expired holds as available instantly; the sweeper only exists to broadcast freed seats.
4. **REST for commands, WS for events** — HTTP owns request/response semantics; WS owns push.
5. **LISTEN/NOTIFY, no Redis, no outbox** — delivery-on-commit kills the dual-write gap; deltas are ephemeral hints healed by seq-gap → snapshot resync (staleness bounded ≈ heartbeat interval). Outbox is for events with independent business value; seat deltas have none.
6. **Normalized M:N (join table)** — one source of truth, history for free; all access paths index-backed; 115 seats/instance → sub-millisecond joins; denormalization is a measured optimization deliberately not taken.
7. **5 s heartbeat** — demo-snappy vs the 15–30 s industry norm (socket.io 25 s, Ably ~15 s); configurable; heartbeats exist to catch half-open sockets — clean closes are detected instantly regardless.
