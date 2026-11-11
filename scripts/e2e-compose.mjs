import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = fileURLToPath(new URL("../compose.yaml", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function exitCodeForSignal(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function normalizeExitCode(result) {
  if (Number.isInteger(result.exitCode)) return result.exitCode;
  return exitCodeForSignal(result.signal);
}

export function createProcessRunner(spawnImplementation = spawn) {
  let activeChild = null;

  return {
    run({ command, args, cwd = repositoryRoot, env = process.env }) {
      return new Promise((resolve) => {
        const child = spawnImplementation(command, args, {
          cwd,
          env,
          stdio: "inherit",
        });
        activeChild = child;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (activeChild === child) activeChild = null;
          resolve(result);
        };
        child.once("error", (error) =>
          finish({ exitCode: 1, signal: null, error }),
        );
        child.once("exit", (exitCode, signal) =>
          finish({ exitCode, signal, error: null }),
        );
      });
    },
    interrupt(signal) {
      if (activeChild && activeChild.exitCode === null)
        activeChild.kill(signal);
    },
  };
}

export async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port)
    throw new Error("Could not reserve a loopback port for the E2E stack.");
  return port;
}

export async function waitForApplication(
  origin,
  {
    fetchImplementation = fetch,
    attempts = 60,
    delayMs = 500,
    isInterrupted = () => false,
  } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isInterrupted())
      throw new Error(
        "E2E run interrupted while waiting for application readiness.",
      );
    try {
      const response = await fetchImplementation(`${origin}/health`, {
        headers: { connection: "close" },
      });
      if (
        response.status === 200 &&
        (await response.text()) === '{"status":"ready"}'
      )
        return;
      lastError = new Error(`Health check returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Compose application did not become ready at ${origin}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function validatePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `DRAWOFF_E2E_PORT must be an integer from 1 through 65535; received ${rawPort}.`,
    );
  }
  return port;
}

export async function runComposePlaywright(playwrightArgs, options = {}) {
  const environment = options.environment ?? process.env;
  const run = options.run;
  if (typeof run !== "function")
    throw new TypeError("runComposePlaywright requires a command runner.");

  const log = options.log ?? console;
  const projectName =
    options.projectName ??
    `drawoff-e2e-${process.pid}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const port =
    environment["DRAWOFF_E2E_PORT"] === undefined
      ? await (options.allocatePort ?? allocateLoopbackPort)()
      : validatePort(environment["DRAWOFF_E2E_PORT"]);
  const origin = `http://127.0.0.1:${port}`;
  const composeEnvironment = {
    ...environment,
    DRAWOFF_PORT: String(port),
    DRAWOFF_FRONTEND_ORIGINS: `http://localhost:${port},${origin}`,
  };
  const compose = (args) =>
    run({
      command: "docker",
      args: [
        "compose",
        "--file",
        composeFile,
        "--project-name",
        projectName,
        ...args,
      ],
      cwd: repositoryRoot,
      env: composeEnvironment,
    });

  let exitCode = 0;
  try {
    log.log(`Starting isolated Compose project ${projectName} on ${origin}...`);
    const startup = await compose([
      "up",
      "--detach",
      "--build",
      "--wait",
      "--wait-timeout",
      "180",
      "postgres",
      "migration",
      "app",
    ]);
    exitCode = normalizeExitCode(startup);

    if (exitCode === 0) {
      if (options.isInterrupted?.()) {
        exitCode = exitCodeForSignal(options.interruptedSignal?.());
      } else {
        await (options.waitForApplication ?? waitForApplication)(origin, {
          isInterrupted: options.isInterrupted,
        });
      }
      if (exitCode === 0 && options.isInterrupted?.()) {
        exitCode = exitCodeForSignal(options.interruptedSignal?.());
      }
      if (exitCode === 0) {
        log.log(`Running Playwright against ${origin}...`);
        const playwright = await run({
          command: npmCommand,
          args: [
            "run",
            "test:e2e",
            "--workspace",
            "frontend",
            "--",
            ...playwrightArgs,
          ],
          cwd: repositoryRoot,
          env: {
            ...environment,
            DRAWOFF_E2E_BASE_URL: origin,
          },
        });
        exitCode = normalizeExitCode(playwright);
      }
    }
  } catch (error) {
    exitCode = options.isInterrupted?.()
      ? exitCodeForSignal(options.interruptedSignal?.())
      : 1;
    log.error(error instanceof Error ? error.message : String(error));
  } finally {
    log.log(`Cleaning up isolated Compose project ${projectName}...`);
    try {
      const cleanup = await compose([
        "down",
        "--volumes",
        "--remove-orphans",
        "--timeout",
        "10",
      ]);
      const cleanupCode = normalizeExitCode(cleanup);
      if (cleanupCode !== 0 && exitCode === 0) exitCode = cleanupCode;
    } catch (error) {
      log.error(
        `Compose cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (exitCode === 0) exitCode = 1;
    }
  }

  return exitCode;
}

async function main() {
  const processRunner = createProcessRunner();
  let interruptedSignal = null;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    processRunner.interrupt(signal);
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    process.exitCode = await runComposePlaywright(process.argv.slice(2), {
      run: processRunner.run,
      isInterrupted: () => interruptedSignal !== null,
      interruptedSignal: () => interruptedSignal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
