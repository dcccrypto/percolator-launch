import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./journeys/ui",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  outputDir: "./.run/pw-artifacts",
  reporter: [["list"], ["json", { outputFile: "./.run/pw-results.json" }], ["html", { outputFolder: "./.run/pw-report", open: "never" }]],
  use: {
    baseURL: process.env.E2E_APP_URL ?? "http://localhost:38590",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
