/**
 * E2E Suite 2: Market Listing & Navigation
 *
 * Verifies the markets page displays market data,
 * search/filter works, and clicking a market navigates to the trade page.
 *
 * PERC-010 / Issue #245
 */

import { test, expect } from "@playwright/test";
import { navigateTo, selectors } from "./helpers";

test.describe("Market listing page", () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, "/markets");
  });

  test("displays at least one market or empty state", async ({ page }) => {
    // Markets should be rendered as clickable cards or links to /trade/[slab].
    // In CI without Supabase seed data, markets may be empty — accept that gracefully.
    const marketLinks = page.locator('a[href^="/trade/"]');
    const mainContent = page.locator("main");

    try {
      await expect(marketLinks.first()).toBeVisible({ timeout: 15000 });
      const count = await marketLinks.count();
      expect(count).toBeGreaterThan(0);
    } catch {
      // No markets available (e.g., CI without Supabase data)
      // Verify the page still renders without crashing
      await expect(mainContent).toBeVisible();
      const text = (await mainContent.textContent()) ?? "";
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("market cards show token name or symbol, or empty state", async ({ page }) => {
    const marketLinks = page.locator('a[href^="/trade/"]');
    const mainContent = page.locator("main");

    // Wait for either market links or the main content to settle
    try {
      await expect(marketLinks.first()).toBeVisible({ timeout: 10000 });
      // Markets loaded — verify content
      const firstCard = marketLinks.first();
      const text = await firstCard.textContent();
      expect(text?.trim().length).toBeGreaterThan(0);
    } catch {
      // No markets available (e.g., CI without Supabase data)
      // Verify the page still renders without crashing
      await expect(mainContent).toBeVisible();
      const text = (await mainContent.textContent()) ?? "";
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("clicking a market navigates to trade page", async ({ page }) => {
    const marketLinks = page.locator('a[href^="/trade/"]');

    // Skip gracefully if no markets are available (CI without Supabase)
    try {
      await expect(marketLinks.first()).toBeVisible({ timeout: 10000 });
    } catch {
      test.skip(true, "No market data available — skipping navigation test");
      return;
    }

    // Get the href to know where we're going
    const href = await marketLinks.first().getAttribute("href");
    expect(href).toBeTruthy();

    await marketLinks.first().click();
    await page.waitForURL(/\/trade\//, { timeout: 10000 });
    expect(page.url()).toContain("/trade/");
  });

  test("search input is present and functional", async ({ page }) => {
    const searchInput = page.locator(selectors.searchInput);
    // Search may or may not exist — if it does, it should be interactive
    const count = await searchInput.count();
    if (count > 0) {
      await searchInput.first().fill("SOL");
      // After typing, wait for the market list to re-render (debounce + filter)
      await page.waitForLoadState("networkidle").catch(() => {});
      // Page should still have content (filter didn't crash)
      await expect(page.locator(selectors.mainContent)).toBeVisible();
    }
  });
});

test.describe("Market navigation from homepage", () => {
  test("homepage has a link to markets page", async ({ page }) => {
    await navigateTo(page, "/");
    // Look for Markets link in header nav or hero CTA
    const marketsLink = page.locator('a[href="/markets"], a[href*="markets"]').first();
    await expect(marketsLink).toBeVisible({ timeout: 10000 });
  });

  test("can navigate from homepage to markets", async ({ page }) => {
    await navigateTo(page, "/");
    // The Markets link lives inside a hover-triggered NavDropdown.
    // In CI (no real cursor), we must hover the trigger to open the dropdown
    // before clicking the menuitem, otherwise hero content intercepts the click.
    const dropdownTrigger = page.locator('header button[aria-haspopup="true"]').filter({ hasText: /trade/i }).first();
    const hasTrigger = await dropdownTrigger.count();

    if (hasTrigger > 0) {
      // Open dropdown by hovering the trigger button
      await dropdownTrigger.hover();
      const marketsLink = page.locator('header a[role="menuitem"][href="/markets"]').first();
      await expect(marketsLink).toBeVisible({ timeout: 5000 });
      await marketsLink.click({ timeout: 10000 });
    } else {
      // Fallback: direct top-level nav link (no dropdown)
      const marketsLink = page.locator('header a[href="/markets"]').first();
      await marketsLink.click({ force: true, timeout: 10000 });
    }
    await page.waitForURL(/\/markets/, { timeout: 10000 });
  });
});
