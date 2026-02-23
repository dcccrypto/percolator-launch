/**
 * E2E Suite 3: Wallet Connection (Privy)
 *
 * Tests the Privy-based wallet connection flow (PR #295):
 * - Connect button (or loading placeholder) is visible
 * - Button has correct text and accessibility attributes
 *
 * IMPORTANT: In CI without NEXT_PUBLIC_PRIVY_APP_ID, Privy never reaches
 * `ready=true`, so the ConnectButton stays in "Loading…" state forever.
 * Tests must handle BOTH states: ready ("Connect") and not-ready ("Loading…").
 *
 * PERC-010 / Issue #245 / PR #295 (Privy migration)
 */

import { test, expect } from "@playwright/test";
import { navigateTo, selectors } from "./helpers";

test.describe("Wallet connection (Privy)", () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, "/");
  });

  test("wallet area is visible in the header", async ({ page }) => {
    // The ConnectButton renders either:
    //   - "Loading…" (disabled) when Privy is not ready (CI without app ID)
    //   - "Connect" when Privy is ready but user is not authenticated
    const walletBtn = page.locator(selectors.walletButton).first();
    await expect(walletBtn).toBeVisible({ timeout: 10000 });
  });

  test("connect button renders with correct text", async ({ page }) => {
    const walletBtn = page.locator(selectors.walletButton).first();
    await expect(walletBtn).toBeVisible({ timeout: 10000 });

    const text = await walletBtn.textContent();
    const trimmed = text?.trim() ?? "";

    // Accept either state — both are valid depending on Privy config
    expect(
      trimmed === "Connect" || trimmed === "Loading…" || trimmed === "Loading"
    ).toBeTruthy();
  });

  test("connect button has aria-label when Privy is ready", async ({ page }) => {
    // Try to find the fully-initialized "Connect wallet" button
    const readyBtn = page.locator('button[aria-label="Connect wallet"]');

    // Give Privy time to initialize (may not happen in CI)
    try {
      await expect(readyBtn.first()).toBeVisible({ timeout: 5000 });
      // If Privy initialized, verify the aria-label
      const ariaLabel = await readyBtn.first().getAttribute("aria-label");
      expect(ariaLabel).toBe("Connect wallet");
    } catch {
      // Privy did not initialize (no app ID in CI) — verify loading state instead
      const loadingBtn = page.locator('button:has-text("Loading")').first();
      await expect(loadingBtn).toBeVisible({ timeout: 5000 });
      // Loading button should be disabled
      await expect(loadingBtn).toBeDisabled();
    }
  });

  test("connect button is a focusable button element", async ({ page }) => {
    const walletBtn = page.locator(selectors.walletButton).first();
    await expect(walletBtn).toBeVisible({ timeout: 10000 });

    // Verify it's an actual <button> element (accessible by default)
    const tagName = await walletBtn.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe("button");
  });

  test("clicking connect button does not crash the page", async ({ page }) => {
    const walletBtn = page.locator(selectors.walletButton).first();
    await expect(walletBtn).toBeVisible({ timeout: 10000 });

    const isDisabled = await walletBtn.isDisabled();
    if (!isDisabled) {
      // Only click if not disabled (loading state is disabled)
      await walletBtn.click();
      await page.waitForTimeout(2000);
    }

    // Page should still be functional after click (no crash)
    const body = page.locator("body");
    await expect(body).toBeVisible();
  });
});
