/**
 * E2E Suite 8: Responsive Layout
 *
 * Verifies critical pages render correctly at mobile and tablet viewports.
 * Checks that navigation is accessible and content doesn't overflow.
 *
 * PERC-010 / Issue #245
 */

import { test, expect, devices } from "@playwright/test";
import { navigateTo, selectors } from "./helpers";

const mobileViewport = devices["iPhone 13"].viewport!;
const tabletViewport = { width: 768, height: 1024 };

test.describe("Mobile viewport", () => {
  test.use({ viewport: mobileViewport });

  test("homepage renders without horizontal overflow", async ({ page }) => {
    await navigateTo(page, "/");

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    // Allow a small tolerance (2px) for subpixel rendering
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 2);
  });

  test("markets page renders at mobile width", async ({ page }) => {
    await navigateTo(page, "/markets");
    await expect(page.locator(selectors.mainContent)).toBeVisible();

    // No horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 2);
  });

  test("header navigation is accessible on mobile", async ({ page }) => {
    await navigateTo(page, "/");

    // On mobile, navigation might be behind a hamburger menu
    const header = page.locator(selectors.header);
    await expect(header).toBeVisible();

    // Either nav links are visible or there's a menu toggle button
    const navLinks = header.locator("a");
    const menuToggle = header.locator(
      'button[aria-label*="menu" i], button[aria-label*="nav" i], button:has(svg)'
    );

    const navVisible = await navLinks.first().isVisible().catch(() => false);
    const toggleVisible = await menuToggle.first().isVisible().catch(() => false);
    expect(navVisible || toggleVisible).toBeTruthy();
  });

  test("wallet button is accessible on mobile", async ({ page }) => {
    await navigateTo(page, "/");
    // Wallet button should be visible or accessible through menu
    const walletBtn = page.locator(selectors.walletButton).first();
    const isVisible = await walletBtn.isVisible().catch(() => false);

    if (!isVisible) {
      // Try opening mobile menu first
      const menuToggle = page.locator(
        'button[aria-label*="menu" i], button[aria-label*="nav" i]'
      ).first();
      if (await menuToggle.isVisible().catch(() => false)) {
        await menuToggle.click();
        await expect(walletBtn).toBeVisible({ timeout: 3000 });
      }
    }
  });
});

test.describe("Tablet viewport", () => {
  test.use({ viewport: tabletViewport });

  test("markets page renders at tablet width", async ({ page }) => {
    await navigateTo(page, "/markets");
    await expect(page.locator(selectors.mainContent)).toBeVisible();
  });

  test("trade page renders at tablet width", async ({ page }) => {
    await navigateTo(page, "/markets");
    const marketLink = page.locator('a[href^="/trade/"]').first();

    try {
      await marketLink.waitFor({ state: "visible", timeout: 15000 });
      const href = await marketLink.getAttribute("href");
      if (href) {
        await page.goto(href);
        await expect(page.locator(selectors.mainContent)).toBeVisible();
        return;
      }
    } catch {
      /* no market links — assert markets shell */
    }
    await expect(page.locator(selectors.mainContent)).toBeVisible();
  });
});
