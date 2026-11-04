import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const workspaces = ["frontend", "backend"];
const children = workspaces.map((workspace) =>
  spawn(npm, ["run", "dev", "--workspace", workspace], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(workspace === "frontend" && process.env["VITE_GAME_SERVER_URL"] === undefined
        ? { VITE_GAME_SERVER_URL: `http://localhost:${process.env["PORT"] ?? "3000"}` }
        : {}),
      ...(workspace === "backend" && process.env["DATABASE_URL"] === undefined
        ? { DATABASE_URL: "sqlite:./backend/data/drawoff.sqlite" }
        : {}),
    },
  }),
);

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
