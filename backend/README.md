# Backend HTTP behavior

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

## In-memory rooms

`src/room-service.ts` provides the in-memory room domain service, independent
of HTTP routes and Socket.IO handlers. It creates private six-character
alphanumeric codes, supports joining with a bare code or `/room/{code}` invite
link, normalizes display names, and returns the shared typed session payload.
Codes are compared case-insensitively. A room in an active match rejects new
players; the service does not impose a product-level player cap.

Rooms expire after **30 minutes of inactivity** by default. Configure a
different positive finite TTL in milliseconds with
`createRoomService({ idleTtlMs })`. Creation starts the TTL and each successful
join resets it. Reads, resumes, leaves, kicks, and rejected joins do not extend
it. Expired rooms are removed lazily when accessed, and all sessions become
invalid with the room. Each successful join extends the room-wide validity
window; resuming a session does not. There is no separate guest-token TTL or
renewal policy.

Guest sessions contain a 256-bit token generated with Node's cryptographic
random source. If that source fails, the room operation fails before creating a
room or player. The token is returned only in the caller's `Session`; the
service keeps a SHA-256 hash scoped to that room and player. Room snapshots
contain only public player summaries. Resume, leave, and kick authenticate the
provided token against both the room and player; `playerId` alone is never
authorization. Leaving or being kicked removes the stored hash and revokes the
session. Only the authenticated host can kick, and kicking is restricted to
the lobby. If the host leaves, the first remaining player becomes host.

The shared Socket.IO contract uses `session:resume` with the same `Session`
shape returned by `room:create` and `room:join`; raw tokens must not be put in
room codes, invite URLs, logs, or room state.
