# Sustained drawing-operation failures

## Impact

Players in the labeled environment and deployed version are repeatedly unable
to synchronize drawing operations. The alert requires both more than 20%
failed drawing requests and at least five failures in five minutes for 10
minutes, so an isolated invalid or stale request does not fire it.

## Triage

1. Open the alert's dashboard link and confirm the affected environment and
   deployed version. Compare drawing-operation rate with operation failures.
2. In Grafana Explore, query Loki for
   `{service_name="drawoff-backend"} |= "Backend operation completed."` and
   filter the structured operation name to `drawing:ops`; use its trace ID to
   inspect the request in Tempo.
3. Check `/health`, Collector/Prometheus health, and the deployment history.
   Determine whether failures began with a release, resource pressure, or a
   persistence/collector incident. Telemetry contains no drawing contents,
   room codes, or player identifiers.

## Mitigate and resolve

- If one deployed version introduced the failures, stop promotion and roll
  back through the documented deployment workflow. For infrastructure
  pressure, restore the unhealthy dependency or capacity before retrying.
- Do not disable server validation or raise drawing limits merely to clear the
  alert. Confirm clients can draw and that both the five-minute failure count
  and ratio return below threshold. Prometheus resolves the alert when the
  expression becomes false on its next evaluation.

## Safe local trigger and resolution

Run the deterministic rule test from the repository root:

```sh
npm run test:observability:alerts
```

The fixture uses synthetic counters only: an isolated failure remains
inactive, sustained 30% failures are pending at 17 minutes and firing at 18
minutes, and a flat failure counter resolves the alert at 20 minutes. It sends
no application requests and has no notification receiver. To inspect the
loaded rule in the running local stack, start it normally and open
<http://127.0.0.1:9090/alerts>; without synthetic traffic the alert remains
inactive.
