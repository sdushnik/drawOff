# DrawOff — MVP Product Specification

**Version:** 2.0  
**Date:** 2026-11-03  
**Status:** MVP scope and implementation recommendations  
**Platform:** Responsive browser-based multiplayer game  
**Working title:** DrawOff

## 1. Product vision

DrawOff is a real-time drawing party game for groups of friends. Everyone joins a private room. In each round, **one player is the Judge and every other player is an Artist**. The Judge chooses a drawing prompt; all Artists draw the same prompt simultaneously, on private canvases, for up to 75 seconds. During that phase, the Judge watches every Artist's live drawing process while Artists see only their own canvases. When all Artists submit or the deadline arrives, drawings freeze; the Judge sees the completed drawings **anonymously**, sees the prompt, and independently rates every drawing from **0 to 100**. Ratings turn directly into points. Judge roles rotate, and the highest total score wins.

The priority is a **fun, polished, feasible first full-stack project**, not a comprehensive social gaming service.

### Core commitments

- **Minimum three players** to start.
- **No arbitrary fixed six-player cap**, and **no spectators**: everyone either Judges or draws every round.
- Exactly **one Judge per round**; **N − 1 Artists** for N players.
- Room access is private by code or invitation link.
- Same word for all Artists, selected from three suggestions or typed by the Judge.
- Artists cannot see other Artists' drawings; the Judge can watch every drawing live.
- The Judge can view live drawings in Grid View or enlarge one in Focus View, but cannot draw or interact with Artist canvases or tools.
- Drawing identities remain hidden from the Judge until ratings are finalized.
- Judge rates **each** anonymously displayed drawing from **0–100**.
- Each Artist receives points equal to their rating.
- Each player Judges exactly once **per cycle**.
- Host chooses **1, 2, or 3 cycles**.

## 2. Decisions and their status

| Topic | Rule | Status |
|---|---|---|
| Room discovery | Private rooms; join via code or link | User-confirmed |
| Player count | At least 3; no fixed gameplay maximum | User-confirmed |
| Participants | One Judge, **all other players draw** | User-confirmed |
| Spectators | **No spectator role** | User-confirmed |
| Word choice | Judge chooses one of three suggestions or writes their own | User-confirmed |
| Drawing duration | Up to 75 seconds; ends early when every Artist submits | User-confirmed |
| Drawing privacy | Artists cannot see each other's drawings while drawing | User-confirmed |
| Judge live viewing | Judge watches all Artists draw during the drawing phase | User-confirmed |
| Judge viewing modes | Grid View and selectable Focus View | User-confirmed |
| Judge prompt visibility | Judge can see the prompt while scoring | User-confirmed |
| Judging | Independent integer rating of **every** drawing, 0–100 | User-confirmed |
| Artist points | Rating is awarded directly as points | User-confirmed |
| Rotation | Each player Judges once per cycle, draws the rest | User-confirmed |
| Match cycles | Host chooses 1, 2, or 3 cycles | User-confirmed |
| Host defaults, reconnection, UI, technology | Described below | Assistant recommendations |

**Superseded earlier ideas:** Exactly two Artists, A/B-only comparisons, 3–6 player capacity, spectators, and three/six/nine rounds as fixed match lengths are **not part of the current design**.

## 3. How a match works

1. A host enters a display name and creates a private room.
2. The app generates a join code and shareable invite link.
3. Friends join. The live lobby shows the connected player roster.
4. The host selects **1, 2, or 3 cycles** (default **1**). The app shows the total number of rounds and an approximate duration.
5. Once **3+ players** are connected, the host starts. The match roster is locked until the match ends.
6. Round 1 assigns one Judge; **every other player is an Artist**.
7. The Judge chooses from three random words or enters a custom word.
8. All Artists receive the same prompt and draw **simultaneously for up to 75 seconds** on individual canvases. Each Artist sees and controls only their own canvas; the Judge watches all canvases update live without being able to draw or interact with them.
9. During drawing, the Judge can use Grid View to see all anonymous canvases at once or Focus View to enlarge any canvas. Switching views does not interrupt drawing updates.
10. Artists may submit early to mark their canvas ready and may resume drawing by pressing the control again while another Artist is still drawing. When all Artists are ready, or at the server-authoritative 75-second deadline, all canvases freeze.
11. The Judge sees **all completed anonymous drawings in a responsive gallery** with the original prompt and assigns **one 0–100 integer rating to each**.
12. After every drawing is rated, the Judge submits all ratings once.
13. The game reveals each Artist's identity and score, shows the round's highest-rated Artist(s), and updates the leaderboard.
14. Another player becomes Judge and the game continues. A full **cycle contains N rounds for N players**.
15. After the chosen number of complete cycles, the match ends and the highest total score wins. Rematch returns everyone to a new match in the same room.

### Round-length examples

| Players (N) | Judges per round | Artists per round | 1 cycle | 2 cycles | 3 cycles |
|---|---:|---:|---:|---:|---:|
| 3 | 1 | 2 | 3 rounds | 6 rounds | 9 rounds |
| 5 | 1 | 4 | 5 rounds | 10 rounds | 15 rounds |
| 8 | 1 | 7 | 8 rounds | 16 rounds | 24 rounds |
| 12 | 1 | 11 | 12 rounds | 24 rounds | 36 rounds |

**Important:** No fixed gameplay maximum does not mean infinite practical server capacity. The app should be designed to handle larger groups, then load-tested and protected with technical safety limits (network payload sizes, rate limits, memory budgets, timeouts). Any operational constraints should be based on measured capacity, not an arbitrary six-player product rule.

## 4. Assistant-selected MVP choices, with rationale and alternatives

### 4.1 One Judge, all others Artists

Every non-Judge participant draws and is judged in **every** round.

**Why:** Everyone plays every round; this matches the intended friends-party atmosphere and avoids idle spectators.

**Alternative rejected:** Two Artists plus waiting players. It left friends inactive and misrepresented the intended gameplay.

### 4.2 Cycles and deterministic fair rotation

Let N be the number of players at match start. Freeze the roster order. For round `r` starting at zero:

- `judge = players[r % N]`
- `artists = all players except judge`
- `totalRounds = N × selectedCycles`, where `selectedCycles ∈ {1,2,3}`

Over one cycle each player is Judge **once** and Artist **N − 1 times**. Over C cycles each player is Judge C times and Artist `(N − 1) × C` times.

**Why:** Equal scoring opportunities, minimal bookkeeping, and predictable schedules.

**Alternatives:** Random Judge selection (can produce unfair repetition), unlimited rounds (no defined winner), fixed number of rounds across all group sizes (unequal Judge duty).

### 4.3 Match scoring and ties

- Each Artist's rating is a **whole number from 0 through 100**, inclusive.
- The server awards points equal to that number: rating 86 → **+86 points**.
- Judge earns **0 points** in that round; everybody has the same number of Judge and Artist turns across complete cycles.
- A round's winner is the Artist (or Artists) with the **highest rating** for that round.
- The match winner is the player (or players) with the **highest cumulative points**.
- Equal top scores produce **co-winners**; no sudden-death tiebreaker in MVP.
- Maximum theoretical score per player: `100 × (N − 1) × selectedCycles`.

**Why:** Transparent and fair because everyone has the same count of drawing opportunities.

**Alternatives:** Awarding Judge points (unnecessary), extra points for winning a round (dilutes 0–100 semantics), comparing only two drawings (doesn't support all Artists).

### 4.4 Prompt selection

- Offer **three distinct random prompts** from a small curated word list.
- Or the Judge enters a custom prompt (**1–40 trimmed characters**).
- Word selection lasts **30 seconds**; if time runs out, the server selects a displayed suggestion automatically.
- All Artists see the same final prompt.
- Judge knows the prompt and sees it during judging.
- Protect against empty input, excessively long inputs and markup; no advanced custom-word moderation in MVP.

**Why:** Lets friends be creative while preventing the room from getting stuck.

**Alternative:** Prompt voting by the whole room (unnecessary extra phase).

### 4.5 Canvas and drawing

**Tools:** Pen, compact color palette, brush sizes, eraser, **Bucket Fill (flood fill)**, undo, and clear.

- A **server-authoritative 75-second timer** controls the latest possible end of drawing.
- Each Artist draws locally on a separate canvas.
- Artists can see and interact only with their own canvas; other Artists' drawings are never sent to them.
- Stream validated drawing events from each Artist to the server and then to the Judge in real time. Do not send live drawing events to other Artists.
- Synchronize Bucket Fill as an atomic Socket.IO drawing action containing the canvas-relative seed position, selected fill color, and ordering/version information. Apply the same bounded flood-fill operation to the Artist's and Judge's canvas state; do not emit one network event per pixel.
- Give each live drawing a stable anonymous label for the round; do not expose its Artist identity to the Judge.
- The Judge can watch all live canvases in Grid View or select one for Focus View. Both views stay synchronized with the same server-held canvas state.
- The Judge is a read-only viewer and cannot draw, edit a canvas, or use Artist drawing tools.
- Artists may submit early to mark their artwork ready; while the phase remains active, pressing the control again resumes drawing.
- Show every participant an anonymous `ready / total Artists` count during drawing; never attach names or canvas data to that progress indicator.
- Move to judging as soon as every Artist is ready. Otherwise, at the server-authoritative 75-second deadline, freeze every canvas, including blank work.
- Play a local countdown tick during the final 10 drawing seconds, with a persistent mute control; audio does not control or synchronize the server timer.
- Retain the latest synchronized canvas state on the server and replay/resynchronize it when the Judge or an Artist reconnects.
- Coalesce or batch high-frequency drawing updates, bound event payloads and rates, and use state checkpoints as needed to keep larger rooms responsive without making final drawing snapshots the only transmitted data.

**Why:** Live Judge spectating is a core part of the party experience; server-mediated, bounded updates preserve privacy between Artists while keeping the Judge's views responsive.

**Alternatives:** Broadcasting Artist strokes to other Artists, layers, shapes, and image uploads.

### 4.6 Anonymous judging gallery

- Shuffle drawing order independently each round.
- Show each drawing as a **numbered anonymous card** (Drawing 1, Drawing 2, …), not just A and B.
- Reuse the round's anonymous drawing labels so the Judge can match live canvases to completed drawings without learning Artist identities.
- The Judge sees the **prompt** at the top of the judging screen.
- Use a responsive grid on desktop and a scrollable single-column gallery on phones.
- Each card has a clear **0–100 integer input**, ideally combining a numeric field with a slider or simple stepper.
- Make it obvious which drawings are still unrated, and show progress such as **5 of 11 rated**.
- **Submit all ratings** becomes available only after every valid rating is entered.
- Judge can review all numbers before submitting; once submitted, ratings are final.
- The artist-to-drawing mapping stays server-side until final submission.
- Afterward reveal each artist's name, rating, round winner(s), and updated leaderboard.

**Why:** A gallery scales much better than a fixed two-drawing comparison and preserves anonymous judging.

**Alternatives:** Pairwise knockout voting, rankings-only, or submitting each rating as soon as entered. These make judging and scoring less intuitive.

### 4.7 Managing judge workload

- Judges may have to rate many drawings (for example, **14** in a 15-player room).
- Use a **time budget that scales with the number of drawings**, such as `max(45, 15 × numberOfArtists)` seconds, with the remaining time visible.
- Warn the Judge before time expires.
- On timeout without complete ratings, pause the phase and give the Judge a short recovery window; if the Judge cannot complete, cancel and retry the unscored round.
- Show a **match-duration estimate** in the lobby derived from phases, number of Artists, and cycles. Label it as an estimate, not a guarantee.

**Why:** A fixed 45-second Judge timer that worked for two Artists would be unfair for a larger group.

**Alternative:** No judging timer (risks stalled rooms). The formula is a starting default to validate in playtests.

### 4.8 Guest access and private rooms

- Players join without an account.
- Display names: **2–20 characters**.
- Rooms have a short, case-insensitive invite code and shareable URL.
- Only the host can start a match, choose cycle count, and remove players **from the lobby**.
- A match requires at least **3 connected participants**.
- The active match roster is locked; newcomers wait for the next lobby and cannot enter mid-match.
- A rematch preserves the room but resets all scores and starts new cycles.
- If the host permanently leaves, assign a new host from the connected roster.
- Use temporary secure session tokens to associate reconnections with the same player.

**Why:** Fast onboarding fits a party game where a friend shares a link.

**Alternatives:** Accounts, friend lists, public matchmaking (unnecessary for a first release).

### 4.9 Disconnects and recovery

**Primary recommendation: pause rather than silently penalize.**

- **Judge disconnects:** Pause the active phase for up to **30 seconds**, notifying the room. If the Judge returns, resume at the preserved phase with remaining time. If not, **cancel the incomplete round without points** and return the match to a recoverable lobby state.
- **Artist disconnects:** Pause for up to **30 seconds**, retain their already synchronized drawing state on the server, and resynchronize it when they return. Unsynchronized local strokes are best-effort. If the Artist does not return, **cancel the incomplete round without points** and return the match to a recoverable lobby state.
- **Any player who has already submitted disconnects:** Keep their submitted drawing. If their input is no longer needed, the current phase can continue, subject to the room's connected-player safety rules.
- **Host disconnects:** The match can continue under a replacement host; a host who is also the active Judge or Artist follows their role's disconnect rules.
- **Less than 3 connected players:** Do not continue scoring a new round. Return to the lobby after the reconnect window.
- **Browser refresh:** Rejoin using the session token and restore the server-authoritative phase and already synchronized canvas state; recover unsent local strokes only if available.
- **Match recovery policy:** For MVP, if a required participant permanently leaves mid-match, end that **incomplete match without a winner**, return to the lobby, and allow a new match with the remaining players if at least 3 remain. This avoids unequal drawing opportunities from changing rosters.
- Completed rounds and existing points are not treated as the final result of an interrupted match.

**Why:** In a system where everyone Judges once and draws all other rounds, silently removing a player can invalidate scoring fairness.

**Alternatives:** Automatic role substitution, AI Judge, immediate forfeiture, dynamic rescheduling and score normalization. These add substantial complexity.

**Engineering caveat:** Preserve synchronized canvas state and game-state snapshots server-side long enough to support the short reconnection window; do not promise that unsent local strokes survive a tab closing unless explicitly implemented.

### 4.10 Results and rematches

- After each round: reveal Artists and ratings card-by-card, then reveal the top drawing(s) and cumulative points within three seconds. Each revealed drawing has an on-demand, short timelapse reconstructed from its retained canvas actions; it does not autoplay.
- At match end: reveal ranked totals sequentially, then display winner(s), number of rounds and cycles, and a **Play Again** option for the host.
- Skip staged delays when the player prefers reduced motion. Reconnects derive round reveal progress from the server deadline instead of restarting the sequence.
- Don't add extensive player statistics in v1.

**Why:** Clear closure and easy replay keep the party experience flowing.

## 5. Screens and key UI elements

| Screen/state | Important contents |
|---|---|
| Home | Game title, Create Room, Join Room |
| Create Room | Display name, Create |
| Join Room | Code/invite link, display name, Join, validation |
| Lobby | Room code/link, roster, connection state, host controls, **cycle selector (1/2/3)**, **estimated rounds and duration**, Start |
| Role Reveal | Round X/Y, current Judge, all Artist participants, user's role |
| Word Selection — Judge | Three suggestions, custom input, countdown, confirm |
| Word Waiting — Artists | Waiting for Judge to select a word |
| Drawing — Artists | Prompt, 75-second timer with optional final-10-second sound, anonymous ready count, canvas and tools, Submit/Continue control |
| Drawing — Judge | 75-second timer with optional final-10-second sound; anonymous ready count; live anonymous canvases in Grid View; select any canvas for Focus View; return to Grid or focus another canvas at any time; no drawing or editing controls |
| Judging — Judge | Prompt, anonymous drawing gallery, rating control per image, rated-count progress, Submit All |
| Judging — Artists | Waiting for the Judge; no submitted ratings or identities leaked prematurely |
| Round Results | Sequentially revealed drawings with artist names and 0–100 ratings, per-drawing timelapse playback, then round winner(s) and points/leaderboard |
| Final Results | Sequential standings reveal, match winner(s), leaderboard, rematch/back to lobby |
| Recovery/Error | Reconnecting, waiting for required player, match interrupted, invalid code |

**Responsive priorities:** Touch-friendly drawing on phones; Judge Grid View adapts to Artist count and viewport; Focus View remains legible and live; image cards work for many submissions; readable rating inputs; clear current phase and time; scroll and zoom without losing canvas content.

## 6. Game state and real-time events

### Server-authoritative state machine

`LOBBY → ROLE_REVEAL → WORD_SELECTION → DRAWING → JUDGING → ROUND_RESULT → (next ROLE_REVEAL | FINAL_RESULT) → LOBBY`

Allow additional `PAUSED_FOR_RECONNECT` and `MATCH_INTERRUPTED` states, with explicit transitions.

**Events:** room created/joined, player joined/left/reconnected, host reassigned, settings changed, game started, round roles assigned, prompt selected, drawing phase started, Artist drawing updates relayed to the Judge, canvas submitted/locked, drawing deadline reached, all canvases frozen, judge ratings submitted, results revealed, scores updated, cycle completed, match ended or interrupted.

**Trusted backend requirements:**

- The server validates room membership, player role, current phase, and action deadlines.
- Only the Judge can select the prompt and submit ratings.
- Only the corresponding Artist can send drawing updates or submit/lock their own canvas.
- The server relays drawing updates only to the Judge and maintains the current canvas state for authorized resynchronization.
- Bucket Fill actions are validated and synchronized as ordered canvas operations, so the Judge's live canvas and reconnect state include the fill without exposing it to other Artists.
- The Judge receives anonymous drawing identifiers and cannot edit canvases; other Artists never receive one another's drawing data.
- Grid and Focus views render the same synchronized state; changing views does not change server state or interrupt updates.
- The server, not the browser, calculates the scoreboard.
- Drawing updates are validated, ordered or safely reconciled, and bounded for payload size and event rate; duplicate final submissions cannot award duplicate points.
- Live canvases are visible only to the Judge during drawing; all identities remain hidden from the Judge until ratings are finalized.
- Artist identities and drawing mapping are not disclosed to the Judge until final ratings are locked.
- Server phase deadlines remain authoritative despite network latency or browser refresh.

## 7. Suggested implementation architecture

This is a recommendation, not a product requirement.

### Practical MVP stack

- **Frontend:** React + TypeScript + Vite
- **Styling:** Tailwind CSS
- **Backend:** Node.js + TypeScript
- **Real-time protocol:** Socket.IO
- **Drawing:** HTML Canvas API with Socket.IO drawing-event synchronization (Artist → server → Judge); server-held canvas state supports Grid/Focus views and reconnect resynchronization
- **Initial persistence:** SQLite-backed durable room and match state behind typed repositories; one backend process owns transient Socket.IO coordination
- **Deployment:** Frontend static host and a persistent backend host with WebSocket support

**Why:** The main learning challenge is real-time coordination, including privacy-preserving live drawing delivery and authoritative phase control. A single authoritative server is simpler than a distributed architecture or database-backed game framework.

**Alternatives:** Supabase/Firebase realtime plus a game coordinator; raw WebSockets; durable relational database from day one. Move to persistent storage and horizontal scaling if real traffic warrants it.

**Important scaling tradeoff:** An uncapped room requires careful attention to **number of connections, drawing-event frequency and bandwidth, aggregate server-held canvas state, and size of the Judge's live grid and judging gallery**. Coalesce or batch updates, bound event sizes and rates, clean up expired rooms, and test with progressively larger rooms. A server deployment may need a configurable **operational safety limit** if tests show instability; that is a capacity-control decision, not a six-player gameplay rule. A single Node.js process is not a promise of unlimited concurrency.

### Suggested data entities

| Entity | Fields (conceptual) |
|---|---|
| Room | code, hostId, status, roster, cycleSetting |
| Player | id, roomCode, name, sessionTokenHash, connectionState |
| Match | id, roomCode, frozenPlayerOrder, selectedCycles, roundIndex, scores, status |
| Round | id, matchId, JudgeId, ArtistIds[], prompt, phase, serverDeadlines |
| Drawing | id, roundId, anonymousLabel, ArtistId, synchronizedCanvasState, updateSequence, submittedAt |
| Rating | roundId, DrawingId, integerScore, finalizedAt |

Keep the artist-to-anonymous-card mapping private on the server until ratings are finalized.

### Security and reliability basics

- Validate all inbound drawing events and bound their payload size and rate.
- Authorize every drawing event against room membership, Artist role, and current phase before relaying it.
- Rate-limit room creation, code attempts, and submits.
- Use unpredictable session tokens.
- Set expiration/cleanup for idle rooms and abandoned matches.
- Treat room codes as invitation links, not strong authentication.
- Limit custom prompt length and sanitize displayed text.

## 8. Edge cases

| Situation | MVP behavior |
|---|---|
| Fewer than 3 players | Start disabled |
| More friends join | Allow subject to **measured server capacity**, not arbitrary six-player limit |
| Invalid room code | Clear validation error |
| Join during active match | Do not enter current match; return message directing to next lobby |
| Artist submits before 75 seconds | Mark that Artist ready; allow them to resume while the phase remains active; end drawing immediately when every Artist is ready |
| Artist does not submit | Freeze the current synchronized canvas at the deadline, including blank work |
| Blank canvas | Accept; Judge may award 0 |
| Rating missing/invalid | Prevent final submission; identify unrated card |
| Multiple equal top ratings | Multiple round winners |
| Multiple equal final totals | Co-winners |
| Many submissions | Responsive gallery, progress counter, scalable Judge timer |
| Duplicate rating submission | Ignore/reject safely; no double points |
| Judge disconnects | Pause up to 30 seconds; resume or interrupt match |
| Artist disconnects before submission | Pause up to 30 seconds; resume or interrupt match |
| Host leaves | Reassign host |
| Browser refresh/reconnect | Recover temporary identity/current phase and resynchronize already synchronized canvas progress from server-held state; unsynchronized local strokes are best-effort |
| Server restart | Restore unexpired rooms, match state, synchronized canvases, and authoritative deadlines; clients reauthenticate and reconnect |
| Player count changes mid-match | Keep locked roster; interrupt rather than silently reweight scoring |

## 9. Explicit MVP scope

### In scope

- Private rooms, code and invite link
- Guest names and host controls
- Minimum 3 players, **no fixed six-player cap**
- **Every non-Judge player draws each round**
- Fair Judge rotation and host-selected **1–3 cycles**
- Judge chooses three suggested prompts or custom word
- Up-to-75-second synchronized canvases with private Artist views, reversible early submit, and live Judge spectating
- Judge Grid View and selectable Focus View, both kept live and anonymous
- Pen, palette, brush sizes, eraser, Bucket Fill (flood fill), undo, and clear, with early canvas locking, deadline freeze, and reconnect resynchronization
- Anonymous **multi-drawing gallery** with 0–100 scores
- Prompt visible to Judge during scoring
- Direct points, round reveals, leaderboard, final results
- Basic connection recovery and clear error states
- Responsive desktop/mobile UI
- Capacity testing and basic anti-abuse/network resource safeguards

### Out of scope

- Spectators and waiting Artist slots
- Fixed two-Artist or A/B-only judging interface
- Public matchmaking and room browser
- Accounts, persistent profiles, friends lists, global leaderboards
- Voice/video chat, chat, spectator voting
- Artist-to-Artist drawing visibility or shared canvases
- Layers, advanced brushes, image uploads
- AI judges, AI image scoring, generated prompts
- Cosmetics, achievements, monetization
- Multi-region server infrastructure and multi-node scaling
- Multi-process or multi-region recovery and distributed timer ownership

## 10. Acceptance criteria

1. A host can create a room and share a code/link.
2. At least 3 friends can join from different devices; the room is **not restricted to six** by game rules.
3. No spectator role exists; every participant is either the Judge or an Artist.
4. The host selects 1, 2, or 3 cycles; total scheduled rounds equal `N × cycles`.
5. For each cycle, every player Judges once and draws in all remaining `N − 1` rounds.
6. Judge picks a suggested or custom word; all Artists receive the same word.
7. Artists can draw concurrently for up to 75 seconds without viewing other Artists' work; the Judge receives their drawing updates live through the server.
8. Artists can use Bucket Fill (flood fill) with the selected palette color; the fill operation synchronizes as a bounded, ordered Socket.IO action and appears consistently on the Judge's live canvas.
9. The Judge can see all live anonymous canvases in Grid View, focus any one canvas, and switch views without losing synchronization; the Judge cannot draw or edit.
10. All canvases freeze at 75 seconds or immediately after every Artist submits; before that collective completion, an Artist may press the submit control again to resume drawing.
11. Reconnecting authorized clients recover already synchronized canvas progress and the current phase.
12. The Judge sees all completed drawings anonymously with the original prompt in a scalable gallery.
13. Every drawing receives a validated whole-number score from 0 to 100.
14. Artist names reveal only after all scores are submitted and locked.
15. Each Artist receives points equal to their rating; Judge earns none that round.
16. Round top ratings and match high total are announced correctly, including ties.
17. Disconnections and repeated submits cannot corrupt scores or the role schedule.
18. Mobile and desktop browser experiences remain usable.
19. The application is tested with several different room sizes, and any capacity-based protection is documented.

## 11. Suggested build sequence

1. **Guest rooms and lobby:** Create/join by code, real-time roster, host controls, cycle selector.
2. **Round orchestration:** Locked roster, Judge rotation, prompts, synchronized server timers.
3. **Drawing and live spectating:** Mouse/touch canvas, pen, palette, brush sizes, eraser, Bucket Fill (flood fill), undo, clear, private Artist canvases, Socket.IO event relay to the Judge, anonymous Grid/Focus views, deadline freeze, and state resynchronization.
4. **Judging and scores:** Anonymous gallery for `N − 1` drawings, integer ratings, reveal, leaderboard.
5. **Reliability and polish:** Reconnect state, timeout/interruption handling, mobile layout, load tests.
6. **Playtesting:** Try 3, 5, 8 and larger groups; measure judging speed, total match length, and backend resource use.

## 12. Risks and questions for playtests (not blockers to MVP)

- **Long sessions:** With N players and multiple cycles, round count grows as `N × cycles`. Show estimated duration and start with 1 cycle by default.
- **Judging load:** More Artists mean more individual ratings. Measure usability of gallery, timer, and rating controls before expanding technical capacity.
- **Strict vs generous Judges:** Different players may use 0–100 differently. Because everyone Judges equally, opportunities are balanced, but scores may still feel subjective; that is part of the party-game appeal.
- **No arbitrary limit vs engineering reality:** The product should not exclude a group of seven just because of an old design cap, but finite hosting resources still require safe operational policies.
- **Live spectating and privacy:** Judge spectating is intentional; prevent Artist-to-Artist visibility and keep the live canvas-to-Artist mapping hidden from the Judge until ratings are finalized.
- **Interrupted matches:** Preserving fairness is more important than forcing a broken match to continue with inconsistent rosters.

---

## Final guiding principle

**Everyone plays every round.** Friends join privately, one Judge sets the prompt, all others draw privately from one another while the Judge watches their anonymous canvases live, the Judge rates every completed drawing from 0–100, and the Judge role rotates fairly through one to three complete cycles.

Prioritize this loop before adding secondary features.
