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
