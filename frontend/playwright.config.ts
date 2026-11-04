import { defineConfig, devices } from "@playwright/test";

const frontendUrl = "http://127.0.0.1:4173";
const backendUrl = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm exec --workspace @drawoff/backend -- tsx test-support/e2e-server.ts",
      cwd: "..",
      url: `${backendUrl}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4173",
      cwd: ".",
      url: frontendUrl,
      env: { ...process.env, VITE_GAME_SERVER_URL: backendUrl },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
