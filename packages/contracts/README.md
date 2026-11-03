# DrawOff contracts

`@drawoff/contracts` is the shared, transport-independent source of DrawOff
domain types and runtime schemas. It owns server-state schemas and the payload
shapes for the MVP Socket.IO commands, acknowledgements, state updates, and
errors. The mock frontend can use the same domain types without depending on
Socket.IO.

Every object schema is strict: undeclared fields are rejected, including nested
objects. Schemas validate inputs without coercion or fallback values. Use
`safeParse` or `parse` at transport and persistence boundaries; do not duplicate
the payload definitions in an application.

Guest identity uses the `Session` shape (`roomCode`, `playerId`, and `token`).
`room:create` and `room:join` return it, and `session:resume`, `room:leave`,
`player:kick`, and subsequent room/match commands submit it. The player ID is
only a selector; the backend must authenticate the room-scoped token. Clients
may persist their own session locally, but must never add the token to room
URLs or other shareable identifiers.

`drawing:ops` carries ordered shared `DrawOp` values with the Artist's session.
The server derives room and Artist identity from that authenticated session;
these operations do not accept client-selected recipients. Judge-only
`liveCanvases` use stable anonymous labels and include a sequence number, a
canvas revision, and a complete snapshot for reconnect recovery. Artist views
continue to expose only their own canvas.

Build the package before importing it in an app. The frontend and backend
workspace scripts build it automatically before development, tests, and builds.
