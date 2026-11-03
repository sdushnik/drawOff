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
join resets it. Reads and rejected joins do not extend it. Expired rooms are
removed lazily when accessed. Session credentials use cryptographically secure
random values and are returned to the caller, but are not stored by this
service; token hashing and reconnection lifecycle belong to the later guest
identity work.
