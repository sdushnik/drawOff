# DrawOff capacity measurement

Generated: 2026-11-04T04:38:30.270Z<br>
Revision: `e4f2c7a`

## Method and predeclared stop criteria

The production frontend build and persistent backend build were exercised over real HTTP/WebSocket ports. One rendered Chromium Judge and independent Socket.IO Artist clients ran simultaneous drawing traffic for the authoritative 60-second phase. Room sizes were tested in order (3, 5, 8, 12, 16) and testing stopped at the first failed threshold or the 16-player safety target. The pass thresholds were: at least 99% accepted events, Judge update p95 at most 500 ms, Judge browser event-loop delay p95 at most 150 ms, backend peak CPU at most 85%, and RSS at most 512 MiB.

Bytes/sec is the serialized Socket.IO application payload observed by the clients; TLS/IP framing is excluded. CPU/RSS are sampled from the backend process only. Every case also verifies active-match late-join rejection, Artist privacy, Judge live updates, and explicit room cleanup.

## Test environment

- Node: v24.21.0
- Platform: darwin arm64
- CPU: Apple M1 (8 logical CPUs)
- Memory: 8192 MiB
- Event cadence: one operation per Artist every 250 ms
- Resource limits: backend defaults documented in `backend/README.md`

## Results

| Players | Connections | Accepted events/s | App bytes/s | Update p95 | Judge loop p95 |   CPU avg/peak |   RSS peak | Result |
| ------: | ----------: | ----------------: | ----------: | ---------: | -------------: | -------------: | ---------: | :----: |
|       3 |           4 |              7.98 |   201991.64 |   12.13 ms |         0.8 ms |    3.19% / 25% |  102.3 MiB |  PASS  |
|       5 |           6 |             15.96 |   794679.87 |    28.7 ms |         1.1 ms |  6.84% / 27.8% | 109.13 MiB |  PASS  |
|       8 |           9 |             27.93 |  2407003.75 |   57.86 ms |           1 ms | 15.18% / 40.3% | 199.08 MiB |  PASS  |
|      12 |          13 |             43.88 |  5990257.69 |   93.08 ms |           1 ms |   27.81% / 50% | 219.27 MiB |  PASS  |
|      16 |          17 |             59.87 | 11198700.47 |  153.47 ms |         1.8 ms | 44.56% / 89.9% | 235.28 MiB |  STOP  |

Each row passed late-join rejection, Judge-only live relay/Artist privacy, and room cleanup. Full raw evidence, including acceptance ratios and drawing-window measurements, is in [capacity-results.json](./capacity-results.json).

## Operational guidance

The first predeclared threshold was reached at 16 players because backend peak
CPU exceeded the target. Do not add a player-count cap. On this hardware, set
the existing configurable room guard to `DRAWING_ROOM_RATE_MAX=500` and
`DRAWING_ROOM_RATE_WINDOW_MS=10000` (50 events/s). That rate is above the
12-player representative workload (43.88/s) but below the 16-player workload
that crossed the CPU threshold (59.87/s), providing a measured operational
safety margin. Re-run the harness on deployment hardware before changing that
rate.

The measured range is an operational observation, not a fixed gameplay maximum. DrawOff still has no six-player cap; every non-Judge participant remains an Artist. Results are single-host measurements and do not establish horizontal-scaling behavior, WAN/TLS overhead, or durable-storage capacity.
