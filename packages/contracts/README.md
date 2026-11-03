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

Build the package before importing it in an app. The frontend and backend
workspace scripts build it automatically before development, tests, and builds.
