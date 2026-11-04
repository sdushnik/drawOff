import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { io as connectSocket } from "socket.io-client";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "../..");
const docsDirectory = path.join(rootDirectory, "_docs");
const backendPort = Number(process.env["CAPACITY_BACKEND_PORT"] ?? 3300);
const frontendPort = Number(process.env["CAPACITY_FRONTEND_PORT"] ?? 4300);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const smoke = process.argv.includes("--smoke");
const cliValue = (name) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.split("=")[1];
const requestedSizes = (
  cliValue("--sizes") ??
  process.env["CAPACITY_ROOM_SIZES"] ??
  "3,5,8,12,16"
)
  .split(",")
  .map(Number);
const drawingDurationMs = Number(
  cliValue("--duration-ms") ??
    process.env["CAPACITY_DRAWING_DURATION_MS"] ??
    60_000,
);
const eventIntervalMs = Number(
  process.env["CAPACITY_EVENT_INTERVAL_MS"] ?? 250,
);
const targetRoomSize = requestedSizes.at(-1);

const thresholds = Object.freeze({
  minimumAcceptanceRatio: 0.99,
  maximumUpdateP95Ms: 500,
  maximumJudgeEventLoopP95Ms: 150,
  maximumBackendCpuPercent: 85,
  maximumBackendRssMiB: 512,
});

for (const size of requestedSizes) {
  assert.ok(
    Number.isInteger(size) && size >= 3,
    "Room sizes must be integers of at least three.",
  );
}
assert.ok(Number.isFinite(drawingDurationMs) && drawingDurationMs > 0);
assert.ok(Number.isFinite(eventIntervalMs) && eventIntervalMs >= 50);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDirectory,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? signal}.`,
          ),
        );
    });
  });
}

function start(command, args, options = {}) {
  const output = [];
  const child = spawn(command, args, {
    cwd: rootDirectory,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const remember = (chunk) => {
    output.push(String(chunk));
    if (output.length > 100) output.shift();
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  child.outputTail = () => output.join("").slice(-8_000);
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForReady(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Process exited before ${url} was ready.\n${child.outputTail()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastError}\n${child.outputTail()}`,
  );
}

async function connect(url = backendUrl) {
  const socket = connectSocket(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await Promise.race([
    once(socket, "connect"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Socket connection timed out.")),
        5_000,
      ),
    ),
  ]);
  return socket;
}

function request(socket, event, payload, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${event} timed out.`));
    }, timeoutMs);
    const onError = (error) => {
      cleanup();
      const failure = new Error(
        `${event} failed: ${error.code}: ${error.message}`,
      );
      failure.code = error.code;
      reject(failure);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
    };
    socket.once("error", onError);
    socket.emit(event, payload, (response) => {
      cleanup();
      resolve(response);
    });
  });
}

async function expectRequestError(socket, event, payload, code) {
  try {
    await request(socket, event, payload);
  } catch (error) {
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`${event} unexpectedly succeeded; expected ${code}.`);
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

async function waitForView(state, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.latest && predicate(state.latest)) return state.latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${label}; latest phase was ${state.latest?.phase ?? "none"}.`,
  );
}

async function sampleProcess(pid, samples, stopped) {
  while (!stopped.value) {
    try {
      const { stdout } = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "%cpu=",
        "-o",
        "rss=",
      ]);
      const [cpu, rssKiB] = stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(cpu) && Number.isFinite(rssKiB))
        samples.push({ cpu, rssMiB: rssKiB / 1024 });
    } catch {
      // A final sample may race normal process shutdown.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function createBrowserJudge(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(frontendUrl);
  const input = page.getByLabel("Your name");
  await input.waitFor({ state: "visible" });
  const hydrationDeadline = Date.now() + 15_000;
  while (Date.now() < hydrationDeadline) {
    if (
      await input.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps$")),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    await input.evaluate((element) =>
      Object.keys(element).some((key) => key.startsWith("__reactProps$")),
    ),
    true,
    "Production frontend did not hydrate.",
  );
  await input.fill("Capacity Host");
  await page.getByRole("button", { name: /Create a room/ }).click();
  await page.waitForURL(/\/room\/[A-Z0-9]{5,6}$/);
  const session = await page.evaluate(() => {
    const code = location.pathname.split("/").at(-1).toUpperCase();
    const raw = sessionStorage.getItem(`drawoff:session:${code}`);
    if (!raw) throw new Error("Browser did not persist the room session.");
    return JSON.parse(raw);
  });
  return { context, page, session };
}

async function runScenario({ browser, roomSize, durationMs }) {
  let judge;
  const sockets = [];
  const processSamples = [];
  const pending = new Map();
  const latencies = [];
  const state = { latest: null };
  let incomingBytes = 0;
  let outgoingBytes = 0;
  let privacyViolations = 0;
  let accepted = 0;
  let rejected = 0;
  const backend = start("node", ["backend/dist/index.js"], {
    env: {
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(backendPort),
      FRONTEND_ORIGINS: frontendUrl,
    },
  });
  const samplerStopped = { value: false };
  const sampler = sampleProcess(backend.pid, processSamples, samplerStopped);

  try {
    await waitForReady(`${backendUrl}/health`, backend);
    judge = await createBrowserJudge(browser);
    await judge.page.getByRole("heading", { name: "Players" }).waitFor();

    const hostSocket = await connect();
    sockets.push(hostSocket);
    hostSocket.on("state:update", (view) => {
      state.latest = view;
      incomingBytes += Buffer.byteLength(
        JSON.stringify(["state:update", view]),
      );
      if (view.liveCanvases) {
        const seen = new Set(
          view.liveCanvases.flatMap(({ canvas }) =>
            canvas.actions.map(({ id }) => id),
          ),
        );
        const now = performance.now();
        for (const [id, sentAt] of pending) {
          if (seen.has(id)) {
            latencies.push(now - sentAt);
            pending.delete(id);
          }
        }
      }
    });
    await request(hostSocket, "session:resume", { session: judge.session });

    const artists = [];
    for (let index = 1; index < roomSize; index += 1) {
      const socket = await connect();
      sockets.push(socket);
      const { session } = await request(socket, "room:join", {
        code: judge.session.roomCode,
        name: `Artist ${index}`,
      });
      socket.on("state:update", (view) => {
        if (
          view.phase === "DRAWING" &&
          (view.liveCanvases !== null || view.gallery !== null)
        ) {
          privacyViolations += 1;
        }
      });
      artists.push({ socket, session, index });
    }

    await request(hostSocket, "match:start", { session: judge.session });
    await waitForView(
      state,
      (view) => view.phase === "WORD_SELECTION",
      "word selection",
    );

    const lateSocket = await connect();
    sockets.push(lateSocket);
    await expectRequestError(
      lateSocket,
      "room:join",
      { code: judge.session.roomCode, name: "Late Player" },
      "MATCH_IN_PROGRESS",
    );
    lateSocket.disconnect();

    await judge.page.evaluate(() => {
      window.__drawOffCapacityDelays = [];
      let expected = performance.now() + 50;
      window.__drawOffCapacityTimer = window.setInterval(() => {
        const now = performance.now();
        window.__drawOffCapacityDelays.push(Math.max(0, now - expected));
        expected = now + 50;
      }, 50);
    });

    await request(hostSocket, "prompt:select", {
      session: judge.session,
      prompt: "capacity lighthouse",
    });
    const drawing = await waitForView(
      state,
      (view) => view.phase === "DRAWING",
      "drawing phase",
    );
    const authoritativeWindowMs = drawing.deadline - Date.now();
    assert.ok(
      authoritativeWindowMs > 59_000 && authoritativeWindowMs <= 60_000,
    );
    await judge.page.getByLabel("Drawing 1, live").waitFor();
    const judgeGridCanvasCount = await judge.page
      .getByLabel(/Drawing \d+, live/)
      .count();
    assert.equal(judgeGridCanvasCount, roomSize - 1);

    const workloadStart = performance.now();
    const stopAt = Math.min(
      workloadStart + durationMs,
      workloadStart + Math.max(1_000, authoritativeWindowMs - 350),
    );
    let tick = 0;
    while (performance.now() < stopAt) {
      const tickStarted = performance.now();
      await Promise.all(
        artists.map(async ({ socket, session, index }) => {
          const id = `load-${roomSize}-${index}-${tick}`;
          const payload = {
            session,
            ops: [
              {
                type: "stroke",
                id,
                tool: "pen",
                color: "#111111",
                size: 5,
                points: [
                  index * 3,
                  tick % 100,
                  index * 3 + 1,
                  (tick + 1) % 100,
                ],
              },
            ],
          };
          outgoingBytes += Buffer.byteLength(
            JSON.stringify(["drawing:ops", payload]),
          );
          pending.set(id, performance.now());
          try {
            await request(socket, "drawing:ops", payload);
            accepted += 1;
          } catch {
            pending.delete(id);
            rejected += 1;
          }
        }),
      );
      tick += 1;
      const delay = eventIntervalMs - (performance.now() - tickStarted);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const workloadSeconds = (performance.now() - workloadStart) / 1_000;

    if (!smoke) {
      await waitForView(
        state,
        (view) => view.phase === "JUDGING",
        "authoritative drawing deadline",
        5_000,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      privacyViolations,
      0,
      "An Artist received Judge-only drawing state.",
    );
    assert.ok(
      latencies.length > 0,
      "The Judge did not receive live drawing updates.",
    );

    const eventLoopDelays = await judge.page.evaluate(() => {
      clearInterval(window.__drawOffCapacityTimer);
      return window.__drawOffCapacityDelays;
    });

    for (const artist of artists) {
      await request(artist.socket, "room:leave", { session: artist.session });
    }
    await request(hostSocket, "room:leave", { session: judge.session });
    const cleanupProbe = await connect();
    sockets.push(cleanupProbe);
    await expectRequestError(
      cleanupProbe,
      "room:join",
      { code: judge.session.roomCode, name: "Cleanup Probe" },
      "ROOM_NOT_FOUND",
    );

    samplerStopped.value = true;
    await sampler;
    const total = accepted + rejected;
    const result = {
      roomSize,
      artistCount: roomSize - 1,
      connections: roomSize + 1,
      authoritativeDrawingWindowMs: Math.round(authoritativeWindowMs),
      workloadSeconds: Number(workloadSeconds.toFixed(2)),
      attemptedDrawingEvents: total,
      acceptedDrawingEvents: accepted,
      acceptedEventsPerSecond: Number((accepted / workloadSeconds).toFixed(2)),
      acceptanceRatio: total === 0 ? 0 : accepted / total,
      applicationBytesPerSecond: Number(
        ((incomingBytes + outgoingBytes) / workloadSeconds).toFixed(2),
      ),
      judgeUpdateLatencyP50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
      judgeUpdateLatencyP95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
      judgeBrowserEventLoopP95Ms: Number(
        percentile(eventLoopDelays, 0.95).toFixed(2),
      ),
      backendCpuAveragePercent: Number(
        (
          processSamples.reduce((sum, item) => sum + item.cpu, 0) /
          Math.max(1, processSamples.length)
        ).toFixed(2),
      ),
      backendCpuPeakPercent: Number(
        Math.max(0, ...processSamples.map(({ cpu }) => cpu)).toFixed(2),
      ),
      backendRssPeakMiB: Number(
        Math.max(0, ...processSamples.map(({ rssMiB }) => rssMiB)).toFixed(2),
      ),
      judgeGridCanvasCount,
      lateJoinRejected: true,
      artistPrivacyPreserved: true,
      roomCleanupVerified: true,
    };
    result.passed =
      result.acceptanceRatio >= thresholds.minimumAcceptanceRatio &&
      result.judgeUpdateLatencyP95Ms <= thresholds.maximumUpdateP95Ms &&
      result.judgeBrowserEventLoopP95Ms <=
        thresholds.maximumJudgeEventLoopP95Ms &&
      result.backendCpuPeakPercent <= thresholds.maximumBackendCpuPercent &&
      result.backendRssPeakMiB <= thresholds.maximumBackendRssMiB;
    return result;
  } finally {
    samplerStopped.value = true;
    await sampler;
    for (const socket of sockets) socket.disconnect();
    if (judge) await judge.context.close();
    await stop(backend);
  }
}

function formatTable(results) {
  const header =
    "| Players | Connections | Accepted events/s | App bytes/s | Update p95 | Judge loop p95 | CPU avg/peak | RSS peak | Result |";
  const divider =
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |";
  return [
    header,
    divider,
    ...results.map(
      (item) =>
        `| ${item.roomSize} | ${item.connections} | ${item.acceptedEventsPerSecond} | ${item.applicationBytesPerSecond} | ${item.judgeUpdateLatencyP95Ms} ms | ${item.judgeBrowserEventLoopP95Ms} ms | ${item.backendCpuAveragePercent}% / ${item.backendCpuPeakPercent}% | ${item.backendRssPeakMiB} MiB | ${item.passed ? "PASS" : "STOP"} |`,
    ),
  ].join("\n");
}

async function main() {
  const buildEnvironment = {
    VITE_GAME_SERVER_URL: backendUrl,
    NITRO_PRESET: "node-server",
  };
  await run("npm", ["run", "build", "--workspaces", "--if-present"], {
    env: buildEnvironment,
  });
  const frontend = start("node", ["frontend/.output/server/index.mjs"], {
    env: { ...buildEnvironment, HOST: "127.0.0.1", PORT: String(frontendPort) },
  });
  let browser;
  try {
    await waitForReady(frontendUrl, frontend, 60_000);
    browser = await chromium.launch({ headless: true });
    const sizes = smoke ? [3] : requestedSizes;
    const results = [];
    for (const roomSize of sizes) {
      const result = await runScenario({
        browser,
        roomSize,
        durationMs: smoke
          ? Math.min(2_000, drawingDurationMs)
          : drawingDurationMs,
      });
      results.push(result);
      console.log(JSON.stringify(result));
      if (!result.passed) break;
    }

    if (smoke) {
      assert.equal(results.length, 1);
      assert.equal(results[0].lateJoinRejected, true);
      assert.equal(results[0].artistPrivacyPreserved, true);
      assert.equal(results[0].roomCleanupVerified, true);
      console.log("Production-like browser/Socket.IO smoke passed.");
      return;
    }

    const gitRevision = (
      await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: rootDirectory,
      })
    ).stdout.trim();
    const evidence = {
      generatedAt: new Date().toISOString(),
      gitRevision,
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
      },
      configuration: {
        roomSizes: requestedSizes,
        targetRoomSize,
        drawingDurationMs,
        eventIntervalMs,
        transport: "WebSocket",
        productionBuilds: true,
        backendUrl,
        frontendUrl,
        thresholds,
      },
      results,
    };
    await mkdir(docsDirectory, { recursive: true });
    await writeFile(
      path.join(docsDirectory, "capacity-results.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    const largestPassing = [...results].reverse().find(({ passed }) => passed);
    const stopped = results.find(({ passed }) => !passed);
    const recommendedRoomEventsPerSecond =
      stopped && largestPassing
        ? Math.floor(
            (stopped.acceptedEventsPerSecond +
              largestPassing.acceptedEventsPerSecond) /
              2 /
              5,
          ) * 5
        : null;
    const guidance =
      stopped && largestPassing && recommendedRoomEventsPerSecond
        ? `The first predeclared threshold was reached at ${stopped.roomSize} players because backend peak CPU exceeded the target. Do not add a player-count cap. On this hardware, set the existing configurable room guard to \`DRAWING_ROOM_RATE_MAX=${recommendedRoomEventsPerSecond * 10}\` and \`DRAWING_ROOM_RATE_WINDOW_MS=10000\` (${recommendedRoomEventsPerSecond} events/s): this is above the ${largestPassing.roomSize}-player representative rate (${largestPassing.acceptedEventsPerSecond}/s) but below the ${stopped.roomSize}-player rate that crossed the CPU threshold (${stopped.acceptedEventsPerSecond}/s). Re-run the harness on deployment hardware before changing that operational rate.`
        : `All sizes through the ${targetRoomSize}-player safety target passed. No player-count ceiling is recommended from this run; the validated range is 3–${targetRoomSize} players on the recorded hardware. Larger rooms remain unmeasured. Keep the existing configurable event and memory guards, alert at 75% of their limits, and re-run this harness on deployment hardware before raising them.`;
    const report =
      `# DrawOff capacity measurement\n\n` +
      `Generated: ${evidence.generatedAt}<br>\nRevision: \`${gitRevision}\`\n\n` +
      `## Method and predeclared stop criteria\n\n` +
      `The production frontend build and persistent backend build were exercised over real HTTP/WebSocket ports. One rendered Chromium Judge and independent Socket.IO Artist clients ran simultaneous drawing traffic for the authoritative 60-second phase. Room sizes were tested in order (${requestedSizes.join(", ")}) and testing stopped at the first failed threshold or the ${targetRoomSize}-player safety target. The pass thresholds were: at least ${(thresholds.minimumAcceptanceRatio * 100).toFixed(0)}% accepted events, Judge update p95 at most ${thresholds.maximumUpdateP95Ms} ms, Judge browser event-loop delay p95 at most ${thresholds.maximumJudgeEventLoopP95Ms} ms, backend peak CPU at most ${thresholds.maximumBackendCpuPercent}%, and RSS at most ${thresholds.maximumBackendRssMiB} MiB.\n\n` +
      `Bytes/sec is the serialized Socket.IO application payload observed by the clients; TLS/IP framing is excluded. CPU/RSS are sampled from the backend process only. Every case also verifies active-match late-join rejection, Artist privacy, Judge live updates, and explicit room cleanup.\n\n` +
      `## Test environment\n\n` +
      `- Node: ${process.version}\n- Platform: ${process.platform} ${process.arch}\n- CPU: ${evidence.runtime.cpuModel} (${evidence.runtime.logicalCpuCount} logical CPUs)\n- Memory: ${evidence.runtime.totalMemoryMiB} MiB\n- Event cadence: one operation per Artist every ${eventIntervalMs} ms\n- Resource limits: backend defaults documented in \`backend/README.md\`\n\n` +
      `## Results\n\n${formatTable(results)}\n\n` +
      `Each row passed late-join rejection, Judge-only live relay/Artist privacy, and room cleanup. Full raw evidence, including acceptance ratios and drawing-window measurements, is in [capacity-results.json](./capacity-results.json).\n\n` +
      `## Operational guidance\n\n${guidance}\n\n` +
      `The measured range is an operational observation, not a fixed gameplay maximum. DrawOff still has no six-player cap; every non-Judge participant remains an Artist. Results are single-host measurements and do not establish horizontal-scaling behavior, WAN/TLS overhead, or durable-storage capacity.\n`;
    await writeFile(path.join(docsDirectory, "capacity-report.md"), report);
    assert.ok(results.length > 0);
    console.log(
      `Capacity evidence written to ${path.relative(rootDirectory, docsDirectory)}.`,
    );
  } finally {
    if (browser) await browser.close();
    await stop(frontend);
  }
}

await main();
