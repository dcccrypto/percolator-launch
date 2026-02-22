import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 * 
 * Tests critical user flows on devnet:
 * - Trade lifecycle (connect → open → close)
 * - Liquidation flow
 * - Devnet mint
 * - WebSocket updates
 * 
 * See TEST_PLAN.md section 4 for test cases
 */
export default defineConfig({
  testDir: './e2e',

  // Don't fail CI if the e2e/ directory doesn't exist yet
  // (e.g. during active backend development phases)
  passWithNoTests: true,
  
  // Run tests in serial (devnet state conflicts in parallel)
  fullyParallel: false,
  workers: 1,
  
  // Fail the build on CI if you accidentally left test.only
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 3 : 0,
  
  // Reporter
  reporter: process.env.CI 
    ? [['html'], ['json', { outputFile: 'test-results.json' }], ['github']]
    : [['html'], ['list']],
  
  // Shared test timeout
  timeout: 60000, // 60s for E2E tests (blockchain interactions)
  
  use: {
    // Base URL for app
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    
    // Collect trace on failure
    trace: 'on-first-retry',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
    
    // Video on failure
    video: 'retain-on-failure',
    
    // Default timeout for actions (click, fill, etc.)
    actionTimeout: 15000,

    // Respect prefers-reduced-motion in CI to skip GSAP animations.
    // ScrollReveal components start at opacity:0 and only animate in when
    // the IntersectionObserver fires — in headless CI this can silently
    // fail, keeping elements invisible. Setting reducedMotion:reduce
    // forces ScrollReveal to instantly show all elements.
    reducedMotion: 'reduce',
  },

  // Configure projects for different browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    
    // Uncomment for cross-browser testing
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
    
    // Mobile viewports
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 13'] },
    // },
  ],

  // Run app server before starting tests
  // CI: use production build (pnpm start) — requires `pnpm build` first
  // Local: use dev server (pnpm dev) and reuse if already running
  webServer: {
    command: process.env.CI ? 'pnpm --filter app start' : 'pnpm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
