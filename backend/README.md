# Backend HTTP behavior

## Frontend origins

HTTP routes and Socket.IO polling use the same explicit CORS origin allowlist.
For local development, the backend allows `http://localhost` and
`http://127.0.0.1` on ports 5173 and 8080. For deployment, configure
`FRONTEND_ORIGINS` as a comma-separated list of exact `http://` or `https://`
origins, such as `https://draw.example`. Production startup fails if the
variable is missing or contains an invalid origin; wildcard origins are
rejected. Credentialed requests are enabled only for listed origins.

`GET /health` is a readiness check, not a process-liveness check. It returns
HTTP 200 with `{"status":"ready"}` only after Fastify's initialization hooks
complete and the Socket.IO server has been created. If the app is not ready, it
returns HTTP 503 with the shared error payload
`{"code":"SERVICE_UNAVAILABLE","message":"Service is not ready."}`.

HTTP errors use the `serviceErrorPayloadSchema` contract:
`{"code":"...","message":"..."}`. Client errors expose a stable code and a
generic, user-safe message. Unexpected server errors return HTTP 500 with
`INTERNAL_SERVER_ERROR`; the details are logged server-side and are never
included in the response.

## Database persistence

`DATABASE_URL` is required by the runnable backend. For local development, use
SQLite and run the versioned migrations before starting the server:

```sh
export DATABASE_URL=sqlite:./data/drawoff.sqlite
npm run db:migrate
npm run dev --workspace @drawoff/backend
```

Relative SQLite paths are resolved from the backend workspace directory because
npm workspace scripts run with `backend/` as their working directory. The root
`npm run dev` command supplies `sqlite:./data/drawoff.sqlite` when the variable
is not already set. `backend/data/` is ignored by Git; keep the file on durable
storage anywhere rooms must survive process restarts. The migration command is
idempotent and creates the parent directory and empty database on a clean
checkout. Tests use isolated temporary files or an explicit
`sqlite::memory:` URL.

Kysely is the typed, database-agnostic query layer. Driver setup is isolated in
`src/database/`; room and match code only exposes durable typed snapshots to a
repository interface. SQLite uses `better-sqlite3`, enables foreign keys, and
commits each authoritative snapshot in one transaction. A startup migration or
connection failure stops startup; there is no runtime fallback to memory.
Client-facing failures are sanitized and never include the URL, SQL, or driver
details.

The database retains rooms and configuration, ordered players and host,
SHA-256 session-token hashes, the frozen roster and Judge schedule, match and
round phases, prompts, deadlines, scores, ratings/results, private anonymous
drawing associations, canvas snapshots/actions/revisions/locks, and duplicate
operation fingerprints. Raw session tokens are never written. Socket IDs,
active connection flags, timer handles, rate-limit windows, and event listeners
remain process-local. On restart all players begin disconnected; persisted
future timers are recreated and overdue deadlines are applied with the normal
state-machine rules before readiness.

PostgreSQL is a follow-up, not implemented here. Switching requires adding
Kysely's PostgreSQL dialect and the `pg` driver, accepting a `postgresql://`
URL in the bootstrap adapter, supplying PostgreSQL-compatible versioned
migrations, and running the same repository/restart/privacy contract tests.

## Room domain behavior

`src/room-service.ts` provides the authoritative room domain service, independent
of HTTP routes and Socket.IO handlers. It creates private six-character
alphanumeric codes, supports joining with a bare code or `/room/{code}` invite
link, normalizes display names, and returns the shared typed session payload.
Codes are compared case-insensitively. A room in an active match rejects new
players; the service does not impose a product-level player cap.

Rooms expire after **30 minutes of inactivity** by default. Configure a
different positive finite TTL in milliseconds with
`createRoomService({ idleTtlMs })`. Creation starts the TTL and each successful
join resets it. Reads, resumes, leaves, kicks, and rejected joins do not extend
it. Expired rooms are removed lazily when accessed and by a periodic sweep,
and all sessions become
invalid with the room. Each successful join extends the room-wide validity
window; resuming a session does not. There is no separate guest-token TTL or
renewal policy.

## Realtime resource limits

The authoritative server rejects over-limit requests before changing match state or
relaying an event. Socket.IO closes a transport that exceeds the default **512 KiB**
inbound message ceiling before application parsing. Valid drawing payloads are
limited to **60 operations per batch**, **600 coordinates per operation**, **20,000
coordinates per continued stroke**, and **4,000 retained actions per canvas**. The
server also defaults to **50,000 retained canvas actions across one room**. Canvas
and room-history overflows are explicit `INVALID_INPUT` errors; batches are never
silently truncated and a rejected batch is not partially committed.

Fixed-window request defaults are conservative provisional deployment guards:

| Scope | Default |
| --- | ---: |
| drawing events per session | 240 / 10 seconds |
| drawing events per room | 10,000 / 10 seconds |
| drawing/rating submissions per session | 20 / minute |
| drawing/rating submissions per room | 2,000 / minute |
| emoji reactions per session | 6 / 3 seconds |
| room creation per connection | 5 / minute |
| room-code guesses per connection | 30 / minute |
| room-code guesses per attempted code | 200 / minute |

An exceeded application rate returns a retryable `REQUEST_FAILED` error containing
the remaining window in milliseconds. Authentication and phase checks still happen
before any drawing relay. Expired/abandoned rooms are swept every 60 seconds in
addition to existing lazy expiry checks.

All thresholds are configurable with positive-integer environment variables:
`MAX_INBOUND_MESSAGE_BYTES`, `MAX_CANVAS_ACTIONS_PER_ROOM`,
`ROOM_CLEANUP_INTERVAL_MS`, `DRAWING_SESSION_RATE_MAX`,
`DRAWING_SESSION_RATE_WINDOW_MS`, `DRAWING_ROOM_RATE_MAX`,
`DRAWING_ROOM_RATE_WINDOW_MS`, `SUBMISSION_SESSION_RATE_MAX`,
`SUBMISSION_SESSION_RATE_WINDOW_MS`, `SUBMISSION_ROOM_RATE_MAX`,
`SUBMISSION_ROOM_RATE_WINDOW_MS`, `REACTION_SESSION_RATE_MAX`,
`REACTION_SESSION_RATE_WINDOW_MS`, `ROOM_CREATE_RATE_MAX`,
`ROOM_CREATE_RATE_WINDOW_MS`, `ROOM_CODE_GUESS_CONNECTION_RATE_MAX`,
`ROOM_CODE_GUESS_CONNECTION_RATE_WINDOW_MS`,
`ROOM_CODE_GUESS_CODE_RATE_MAX`, and `ROOM_CODE_GUESS_CODE_RATE_WINDOW_MS`.

These are operational controls, not gameplay rules. There is no fixed six-player
maximum and no configured player-count ceiling. Issue #25 must load-test and tune
these provisional values against measured bandwidth, latency, and memory budgets.

Guest sessions contain a 256-bit token generated with Node's cryptographic
random source. If that source fails, the room operation fails before creating a
room or player. The token is returned only in the caller's `Session`; the
service keeps a SHA-256 hash scoped to that room and player. Room snapshots
contain only public player summaries. Resume, leave, and kick authenticate the
provided token against both the room and player; `playerId` alone is never
authorization. Leaving or being kicked removes the stored hash and revokes the
session. Only the authenticated host can kick, and kicking is restricted to
the lobby. If the host leaves, the first remaining connected player in
room/join order becomes host. If no connected player remains after that
permanent departure, the room is removed. During a match, a host who loses
their final socket transfers host controls to the first connected player
without changing the frozen roster or Judge schedule; reconnecting does not
reclaim those controls.

The shared Socket.IO contract uses `session:resume` with the same `Session`
shape returned by `room:create` and `room:join`; raw tokens must not be put in
room codes, invite URLs, logs, or room state.

The backend registers Socket.IO handlers for room creation, joining, session
resume, subscription, leave, host kick, and host cycle selection. A successful
create or join attaches the authenticated socket to its room and sends every
connected member a personalized `state:update` containing the server-owned
roster, host, cycle selection, and connection state. The same room-only updates
are sent after joins, leaves, disconnects, reconnects, and cycle changes.
Reconnect with the saved session using `session:resume`; the player keeps their
identity and is marked connected again. `state:subscribe` reattaches the
session and returns the initial view. Room invite URLs use `/room/{code}` and
the frontend route accepts that link as its join flow.

The host can select exactly 1, 2, or 3 cycles (default 1), kick a player while
the room is in the lobby, and start only when at least three players are
connected. Cycle, kick, and start requests are authenticated and enforced by
the room service; successful changes are broadcast as personalized
`state:update` events. A started room is marked in the lobby view so controls
are removed or disabled, and later lobby mutations are rejected. There is no
fixed player maximum. Starting snapshots the connected players in their
current room order and fixes the match at exactly `roster size × cycle count`
rounds. For zero-based round `r`, `roster[r % roster size]` is the Judge and
every other frozen roster member is an Artist. Disconnects do not change that
schedule, and the server does not silently substitute or reorder players.
Authorized roster members receive the frozen `match.order`, total round count,
current round assignment, and their role in their personalized view. This
initial scheduling does not advance match phases or deadlines; gameplay phase
transitions are handled separately.

Successful requests are acknowledged only to the requesting socket using the
shared response schemas. Failures emit the shared `error` payload to that
socket; the server does not log request payloads or include submitted
credentials in errors. Resume, leave, kick, and cycle changes pass the
submitted session to `RoomService` for room-and-player token verification; a
client-supplied player ID by itself is never authorization. New joins to a room
marked as having an active match fail with `MATCH_IN_PROGRESS` before
membership or any roster update changes.

## Authoritative match phases

`MatchStateMachine` owns normal gameplay phase transitions and publishes the
current phase and server deadline in each personalized view. Match start enters
`ROLE_REVEAL` for 4 seconds; its server timer advances to `WORD_SELECTION` for
30 seconds. A valid `prompt:select` request or the selection timeout advances
the match to drawing. A single server timer starts with that phase and
establishes its 75-second deadline; the server enters `JUDGING` at that
boundary, or earlier when every Artist has submitted. The Judge's deadline is `max(45 seconds, 15 seconds × Artist count)`. Rating
submissions are validated and scored by the state machine; a complete valid
submission enters `ROUND_RESULT` for 12 seconds. The server timer then advances
to the next `ROLE_REVEAL`, or to `FINAL_RESULT` after the last scheduled round.

At `FINAL_RESULT`, each player view includes server-derived cumulative standings,
all players tied for the highest total, and the completed round and cycle counts.
Only the host can send `match:rematch`, and the server rejects it before the
final result. A valid rematch clears the schedule and all match progress while
preserving the private room, join code, guest identities, selected cycle count,
and connection state. The clean lobby is broadcast to every connected room
participant; the next `match:start` freezes the players connected at that time.

Boundary methods authenticate the saved room session, frozen roster
membership, current Judge role, phase, and server-clock deadline before
mutating phase state. Client timestamps are not accepted. Repeated, stale, and
racing timer callbacks are guarded by per-room transition generations; delayed
callbacks preserve the scheduled boundary rather than extending a phase. The
clock and timer functions are injectable for deterministic tests.

Prompt selection and its timeout fallback are owned by #11; canvas freeze and
early submission are implemented by #16. The state machine does not implement
judging timeout behavior.

When a required match participant loses their final active socket, the server
pauses the current phase for at most 30 seconds. The server preserves the
phase's remaining time and authoritative canvas snapshots/revisions, publishes
the reconnect deadline to the room, and rejects gameplay mutations while
paused. A room-scoped session-token resume restores the same identity and view;
after every required participant returns, the phase continues with exactly its
saved remaining time. Submitted Artists are no longer required during drawing,
and only the Judge is required during judging. If a required participant misses
the reconnect deadline, the incomplete match is discarded without points or a
winner and the private room returns to a recoverable lobby. The lobby notice
states whether at least three connected players are available to start again.
An explicit permanent leave also cancels an incomplete match immediately. Host
reassignment never rewrites the frozen roster or Judge rotation, and requests
from a former host are rejected after ownership moves.

The Judge receives three distinct, curated prompt suggestions when
`WORD_SELECTION` begins. Artists receive neither the suggestions nor a prompt
until selection is finalized. Send `prompt:select` with the Judge's session and
either one displayed suggestion or custom text. The server trims and collapses
whitespace, accepts only 1–40 normalized characters, and rejects markup. The
30-second selection timer chooses one of the same three suggestions if the
Judge does not submit in time. The finalized prompt is included in every
Artist's and the Judge's personalized drawing, judging, and result views,
including views sent when a session reconnects.

## Live drawing synchronization

During `DRAWING`, send `drawing:ops` with the attached Artist's authenticated
session and an ordered array of shared `DrawOp` values. The session, not
client-supplied artist, room, or recipient fields, determines which canvas is
updated; undeclared fields are rejected. The server revalidates the room
session, frozen Artist assignment, drawing phase, lock state, and its own
deadline before applying the batch. An accepted batch is applied atomically in
arrival order using the shared canvas operation format. Replayed operation IDs
are idempotently ignored; reusing an ID for a different operation is rejected.
Stroke segments may reuse their ID when their tool, color, and size match.
There are no per-pixel events.

Only the submitting Artist and current Judge receive drawing-related
`state:update` events. Artist views contain only that Artist's `myCanvas`;
Judge views contain `liveCanvases` in stable `Drawing 1`, `Drawing 2`, … order,
without artist names or IDs. Each live canvas includes a sequence counter, its
canvas revision (`canvas.rev`), lock state, and a complete snapshot. The
sequence advances for each accepted canvas mutation and lock; duplicate or
rejected operations do not change either counter. A reconnect or
`state:subscribe` returns the complete current snapshot, so a client can recover
without replaying missed updates.

An Artist may send `drawing:submit` before the deadline to mark their own canvas
ready; other Artists can continue drawing. Sending it again while the phase is
still active resumes that Artist's canvas. When every Artist is ready, or at the
75-second boundary, the server locks every canvas—including untouched blank
canvases—and transitions to `JUDGING` once. The server clock rejects drawing
operations and submissions at or after the deadline, even if a scheduled timer
callback is delayed. During judging, the Judge continues to receive every
immutable canvas under its original anonymous label, while Artists receive only
their own locked snapshot and cannot modify or resubmit it.

## Ratings and round results

The Judge submits `ratings:submit` with the attached Judge session and a
ratings record keyed by the exact anonymous labels shown in `gallery` (for
example, `Drawing 1`). The server accepts exactly one integer rating from 0
through 100, inclusive, for every frozen drawing and rejects missing or extra
labels. It never accepts client-supplied Artist identities or point awards.
Invalid requests leave the phase, scores, and personalized views unchanged.

On the first valid submission, the server resolves each label to its Artist
using the frozen server-side drawing order, copies each frozen canvas into the
result, adds the rating to that Artist's cumulative score, and selects every
Artist tied for the highest rating in stable drawing order. The Judge earns no
points for the round. The complete result and updated totals are published
together to every match player in `ROUND_RESULT`; before that transition the
Judge's gallery remains anonymous and all views have no round result.
Repeating the exact submission during the result phase succeeds without
applying points or publishing a second result; a changed retry is rejected.
Round results do not calculate final match standings or rematch behavior.
