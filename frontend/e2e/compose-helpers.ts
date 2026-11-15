import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const composeFile = fileURLToPath(new URL("../../compose.yaml", import.meta.url));

export async function restartComposeApp(
  baseUrl: string = process.env["DRAWOFF_E2E_BASE_URL"] ?? "http://127.0.0.1:8080",
): Promise<void> {
  const projectName =
    process.env["DRAWOFF_E2E_COMPOSE_PROJECT"] ??
    process.env["COMPOSE_PROJECT_NAME"] ??
    "drawoff";

  const result = spawnSync(
    "docker",
    ["compose", "--file", composeFile, "--project-name", projectName, "restart", "app"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to restart app container in Compose: ${result.stderr || result.stdout}`,
    );
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { connection: "close" },
      });
      if (response.status === 200 && (await response.text()) === '{"status":"ready"}') {
        return;
      }
    } catch {
      // Wait for the app container to come back up
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`App container at ${baseUrl} did not become ready after restart within 60s.`);
}
