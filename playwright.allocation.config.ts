import { defineConfig, devices } from "@playwright/test";

/**
 * Local-only config for e2e/allocation-checker.spec.ts, driven by
 * app/scripts/allocation/e2e-local.ts (which starts Postgres and `next start`).
 * No webServer: the harness owns the server lifecycle.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "allocation-checker.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: process.env.ALLOC_E2E_JSON ?? "test-results/allocation-e2e.json" }]],
  use: { actionTimeout: 15_000, trace: "off", screenshot: "off", video: "off", reducedMotion: "reduce" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
