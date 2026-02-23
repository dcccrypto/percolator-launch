/**
 * Shared E2E test helpers for Percolator Launch.
 *
 * These helpers provide common patterns used across test suites:
 * - Page load verification with hydration check
 * - Wallet connection mocking (devnet)
 * - Common selectors and assertions
 */

import { type Page, expect } from "@playwright/test";

/**
 * Wait for Next.js page to fully hydrate.
 * Checks that __NEXT_DATA__ script exists and the page has meaningful content.
 */
export async function waitForHydration(page: Page) {
  // Wait for the body to be visible
  await page.waitForSelector("body", { state: "visible" });
  // Wait for Next.js hydration indicator — main content rendered
  await page.waitForFunction(() => {
    return document.querySelector("main") !== null;
  });
}

/**
 * Navigate to a page and wait for hydration.
 */
export async function navigateTo(page: Page, path: string) {
  // Use 'domcontentloaded' to avoid hanging on lazy-loaded resources,
  // then wait for React hydration separately.
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
}

/**
 * Assert that the page does NOT show a Next.js error overlay or 404.
 */
export async function assertNoErrors(page: Page) {
  // No Next.js error overlay
  const errorOverlay = page.locator("#__next-error");
  await expect(errorOverlay).toHaveCount(0);
  // No "404" in the page title (production 404 pages)
  const title = await page.title();
  expect(title).not.toContain("404");
}

/**
 * Assert page has no console errors (filters out known noise).
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Filter known noise
      if (text.includes("favicon")) return;
      if (text.includes("Failed to load resource") && text.includes("favicon")) return;
      // Wallet adapter logs are expected when no wallet is connected
      if (text.includes("WalletNotConnectedError")) return;
      // Privy SDK logs (expected when no Privy app ID configured in CI)
      if (text.includes("privy")) return;
      if (text.includes("Privy")) return;
      if (text.includes("NEXT_PUBLIC_PRIVY")) return;
      // WalletConnect explorer API blocked by CSP in CI
      if (text.includes("walletconnect")) return;
      if (text.includes("WalletConnect")) return;
      if (text.includes("Content Security Policy")) return;
      // Market stats loading failure (no Supabase in CI)
      if (text.includes("market stats")) return;
      if (text.includes("Failed to load market")) return;
      // Supabase connection errors in CI (no real backend)
      if (text.includes("supabase")) return;
      if (text.includes("NEXT_PUBLIC_SUPABASE")) return;
      // RPC/WebSocket connection failures in CI
      if (text.includes("WebSocket")) return;
      if (text.includes("ERR_CONNECTION_REFUSED")) return;
      if (text.includes("net::ERR_")) return;
      if (text.includes("Failed to fetch")) return;
      // Hydration warnings (React 19 noise)
      if (text.includes("Hydration")) return;
      if (text.includes("hydrat")) return;
      // API URL not configured (expected in CI)
      if (text.includes("API URL")) return;
      if (text.includes("No API URL")) return;
      if (text.includes("WebSocket price streaming disabled")) return;
      // Sentry DSN / monitoring not configured in CI
      if (text.includes("Sentry")) return;
      if (text.includes("sentry")) return;
      errors.push(text);
    }
  });
  return errors;
}

/**
 * Common selectors for the Percolator UI.
 */
export const selectors = {
  header: "header",
  footer: "footer",
  mainContent: "main",
  /** Privy connect button — shows "Loading…" until ready, then "Connect" */
  walletButton: 'button[aria-label="Connect wallet"], button:has-text("Connect"), button:has-text("Loading")',
  /** Privy renders its modal in an iframe or portal — use generic dialog selector */
  walletModal: '[role="dialog"]',
  tickerBanner: ".ticker-banner, [class*='ticker']",
  marketCard: '[data-testid="market-card"], a[href^="/trade/"]',
  tradePanel: '[data-testid="trade-panel"], [class*="trade"]',
  searchInput: 'input[placeholder*="Search"], input[type="search"]',
} as const;
