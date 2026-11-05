# DrawOff MVP Backlog

## 1. Setting up the empty project and a passing test
Goal: Create a minimal, runnable TypeScript project using the selected stack with at least one passing automated test.
Description: Set up a clear frontend/backend workspace using React, TypeScript, Vite, Tailwind CSS, Node.js, Fastify, and Socket.IO, with documented local development and test commands. Keep the application otherwise empty and include a small smoke test that passes from a fresh dependency install.

## 2. Defining shared game contracts
Goal: Define validated, shared types for room, player, match, round, drawing, and rating data.
Description: Create frontend/backend-shared TypeScript contracts and runtime validation schemas for Socket.IO payloads and server state. Cover the game phases, role names, 1–3 cycle setting, anonymous drawing identifiers, drawing updates, and integer ratings from 0 to 100.

## 3. Adding backend health and error handling
Goal: Provide a tested Fastify health endpoint and consistent API error responses.
Description: Add a health check that confirms the server is ready to accept connections, plus a shared error response format for HTTP failures. Cover successful and failure responses with focused tests without implementing game behavior.

## 4. Creating and joining private rooms
Goal: Let guests create a room and join it through a private code or invite link.
Description: Implement an in-memory room service that generates collision-resistant, case-insensitive join codes and supports room lookup and joining. Validate display names as 2–20 characters, return clear errors for invalid or full/expired rooms, and test the service independently of the UI.

## 5. Managing guest identity and reconnection tokens
Goal: Associate each guest with a secure temporary identity that can be restored after reconnecting.
Description: Generate unpredictable session tokens and associate them with players without requiring accounts. Store only a token hash in server-side player state, validate tokens on reconnect, and test that invalid tokens cannot claim another player's session.

## 6. Building the home and guest entry screens
Goal: Provide responsive create-room and join-room entry flows for guests.
Description: Build the home, create-room, and join-room screens using React, TypeScript, and Tailwind CSS. Collect and validate the guest display name and room code, connect the screens to the room service, and show understandable validation and network errors.

## 7. Implementing the live lobby
Goal: Show a room's current roster and connection state to all lobby participants.
Description: Add Socket.IO room membership and real-time roster updates for guests who create, join, leave, or reconnect to a room. Build the lobby UI to show the room code, shareable invite link, player names, host, and connection status; do not allow mid-match entrants into the active roster.

## 8. Adding lobby host controls and cycle selection
Goal: Let the host configure and manage a lobby before starting a match.
Description: Allow only the host to remove players from the lobby and select 1, 2, or 3 match cycles, defaulting to 1. Keep the start action disabled until at least three players are connected, and broadcast valid setting changes to everyone in the lobby.

## 9. Implementing fair match scheduling
Goal: Assign roles deterministically so each player Judges once per cycle and draws in every other round.
Description: Freeze the connected roster and its order when a match starts, then calculate `N × cycles` rounds with the Judge rotating by roster order. Add focused tests for 3-, 5-, and 8-player rosters across 1–3 cycles, including each player's Judge and Artist counts.

## 10. Building the authoritative match state machine
Goal: Enforce legal match phases and server-controlled deadlines.
Description: Implement the server-owned transitions for lobby, role reveal, word selection, drawing, judging, round results, final results, reconnect pause, and interruption. Reject actions that do not match the current phase or deadline, and test valid transitions and representative invalid transitions.

## 11. Implementing prompt selection
Goal: Let the Judge select one of three suggestions or enter a valid custom prompt.
Description: Provide three distinct suggestions, accept trimmed custom prompts of 1–40 characters, and have the server choose a displayed suggestion if the 30-second selection timer expires. Ensure all Artists receive the same final prompt and the Judge can see it during judging.

## 12. Building role reveal and prompt waiting screens
Goal: Show each player their role and the appropriate waiting state for word selection.
Description: Add responsive role-reveal and word-waiting screens that display round progress, the Judge, and the player's Judge or Artist role. Show prompt controls only to the Judge and a waiting message to Artists until the server confirms the selected prompt.

## 13. Building the Artist drawing canvas
Goal: Let each Artist draw privately on a usable mouse- and touch-enabled canvas.
Description: Implement the HTML Canvas drawing surface with pen, compact color palette, brush sizes, eraser, undo, clear, and reversible early submit controls. Artists must see and control only their own canvas, and the drawing UI must show the prompt and server-authoritative 75-second countdown.

## 14. Synchronizing drawings live to the Judge
Goal: Stream each Artist's drawing updates through the server to the Judge without exposing them to other Artists.
Description: Use Socket.IO to validate and relay bounded drawing events only from the corresponding Artist to the current Judge during the drawing phase. Maintain each anonymous canvas's latest server-side state and sequence/checkpoint information so the Judge can receive a consistent stream without learning Artist identities.

## 15. Building the Judge's live Grid and Focus views
Goal: Let the Judge watch all anonymous drawings live and focus any one canvas.
Description: Build a responsive Grid View that adapts to the number of Artists and viewport, plus a Focus View that enlarges a selected canvas. Let the Judge switch views or select another canvas at any time without interrupting updates; provide no drawing or editing tools to the Judge.

## 16. Freezing canvases at the drawing deadline
Goal: End the drawing phase at 75 seconds or when every Artist submits, and preserve every final canvas for judging.
Description: Have the server freeze all synchronized canvases at the authoritative deadline, including blank drawings, then transition to judging. An Artist's early submission marks only that Artist ready and can be reversed while another Artist is still drawing; the final Artist submission ends drawing immediately.

## 17. Building the anonymous judging gallery
Goal: Let the Judge review every completed drawing and rate it independently from 0 to 100.
Description: Display the prompt and all frozen drawings under anonymous numbered labels, shuffled independently for the round and consistent with their live-view labels. Provide validated whole-number rating controls, unrated progress, and a Submit All action that stays disabled until every drawing has a valid rating.

## 18. Calculating and revealing round results
Goal: Award server-calculated points and reveal identities only after ratings are finalized.
Description: Accept one final rating submission from the Judge, map anonymous drawings to Artists only on the server, and award each Artist points equal to their rating. Then reveal names and ratings, show all round top scorers and updated cumulative totals, and test scoring, ties, and duplicate-submission handling.

## 19. Building final results and rematches
Goal: Show match winners and allow the host to start a fresh match in the same room.
Description: Display ranked cumulative scores, co-winners for tied highest totals, and the completed round and cycle counts. Let the host start a rematch that resets scores and uses a newly frozen roster while retaining the private room.

## 20. Recovering live drawing state after disconnects
Goal: Resume a paused round with synchronized drawing progress intact when a required player reconnects.
Description: Pause the active phase for up to 30 seconds when the Judge or an Artist disconnects, preserve server-held canvas state and remaining time, and restore the correct view and phase after token-authenticated reconnection. Treat unsynchronized local strokes as best-effort; if a required player does not return, cancel the incomplete match without awarding round points.

## 21. Handling host changes and match interruptions
Goal: Keep room ownership and match outcomes consistent when players leave unexpectedly.
Description: Reassign the host to a connected lobby participant when the host leaves, and prevent incomplete roster changes from silently altering match fairness. Return interrupted matches without a winner to a recoverable lobby when possible, and show clear state-specific messages to participants.

## 22. Hardening realtime event and room resource limits
Goal: Protect the server and keep live drawing responsive as Artist counts grow.
Description: Enforce drawing-event payload and frequency limits, validate event order or safely reconcile updates, rate-limit room creation and code attempts, and expire idle rooms. Ensure authorization checks happen before relay and verify that Artist drawing data is never emitted to other Artists.

## 23. Polishing responsive and accessible gameplay screens
Goal: Make drawing, live spectating, judging, and results usable on desktop and mobile browsers.
Description: Review touch targets, canvas sizing, scrolling, focus behavior, readable timers, and rating controls across screen sizes. Ensure Grid View remains understandable with many canvases and Focus View stays legible without obscuring phase or time information.

## 24. Testing end-to-end multiplayer game flows
Goal: Verify the full private-room game loop across multiple browser clients.
Description: Add automated integration coverage for room creation and joining, minimum player requirements, role rotation, prompt selection, private Artist drawing, Judge-only live updates, ratings, score reveal, and rematch. Include reconnect and duplicate-event cases that must not leak identities or award duplicate points.

## 25. Measuring room capacity and deployment behavior
Goal: Validate practical capacity and document how to run the MVP in production-like hosting.
Description: Load-test progressively larger rooms, including 3, 5, 8, and larger player groups, while measuring event bandwidth, latency, memory, and Judge grid responsiveness. Document measured operational safety limits, environment configuration, and deployment of the static frontend and persistent Socket.IO-capable backend without turning a measured limit into a fixed six-player gameplay rule.

## 26. Implementing synchronized Bucket Fill
Goal: Add a Bucket Fill tool that Artists can use on their canvas and the Judge can watch update live.
Description: Add a Bucket Fill option to the Artist canvas toolbar and implement a bounded flood-fill algorithm that fills a contiguous region from the selected seed point with the selected palette color. Synchronize each fill as an ordered Socket.IO canvas action through the server to the Judge, and test that the Artist and Judge canvases stay consistent without exposing drawing data to other Artists.

## 27. Persisting rooms and matches in SQLite
Goal: Replace process-only durability with transactional SQLite persistence while preserving the existing TypeScript architecture and realtime contracts.
Description: Configure Kysely and SQLite through `DATABASE_URL`, store room, player, match, deadline, score, rating, and synchronized canvas state behind typed repository interfaces, restore active games and timers after restart, and keep sockets, active connections, timer handles, and rate counters transient.

## 28. Adding and validating the PostgreSQL persistence adapter
Goal: Run the same persistence contract against PostgreSQL without changing game-domain or transport code.
Description: Add Kysely's PostgreSQL dialect and driver, PostgreSQL-compatible migrations and CI coverage, then validate repository, restart, privacy, idempotency, and concurrency behavior. This is not part of issue 27.

## 29. Deploying durable persistence and coordinating multi-instance runtime state
Goal: Provision, back up, monitor, and safely operate durable storage with more than one backend process.
Description: Define production database provisioning, backup/restore, rollout, distributed timer ownership, locks, shared rate limiting, and Socket.IO horizontal coordination. This is not part of issue 27.
