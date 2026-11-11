import { defineConfig, devices } from "@playwright/test";

const applicationUrl = process.env["DRAWOFF_E2E_BASE_URL"] ?? "http://127.0.0.1:8080";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 7_000 },
  retries: process.env["CI"] ? 1 : 0,
  reporter: [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  preserveOutput: "failures-only",
  use: {
    baseURL: applicationUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
