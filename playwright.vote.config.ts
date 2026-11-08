import { defineConfig, devices } from "@playwright/test";

/**
 * Local-only config for e2e/vote.spec.ts, driven by app/scripts/vote/e2e-local.ts
 * (which starts a throwaway Postgres and `next start`). No webServer.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "vote.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: process.env.VOTE_E2E_JSON ?? "test-results/vote-e2e.json" }]],
  use: { actionTimeout: 15_000, trace: "off", screenshot: "off", video: "off", reducedMotion: "reduce" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
