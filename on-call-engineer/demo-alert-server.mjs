#!/usr/bin/env node
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = 39070;
const alert = {
  state: "firing",
  activeAt: "2026-11-19T00:00:00.000Z",
  labels: {
    alertname: "DrawOffSustainedDrawingOperationFailures",
    deployment_environment_name: "controlled-demo",
    service_version: "synthetic",
    severity: "warning",
    owner: "gameplay-backend",
  },
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/api/v1/alerts") {
    response.end(JSON.stringify({ status: "success", data: { alerts: [alert] } }));
    return;
  }
  if (url.pathname === "/api/v1/query") {
    const query = url.searchParams.get("query") ?? "";
    const value = query.includes("failures_total") && query.includes("increase")
      ? "9"
      : query.includes("operations_total") && query.includes("increase")
        ? "30"
        : "0.3";
    response.end(JSON.stringify({
      status: "success",
      data: { resultType: "vector", result: [{ value: [0, value] }] },
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ status: "error" }));
});

server.listen(port, host, () => {
  process.stdout.write(`Synthetic alert API listening at http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
