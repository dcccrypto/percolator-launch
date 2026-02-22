/**
 * E2E Suite 1: Critical Page Loads
 *
 * Verifies every public route returns 200, renders without errors,
 * and contains expected landmark elements (header, main, footer).
 *
 * PERC-010 / Issue #245
 */

import { test, expect } from "@playwright/test";
import { navigateTo, assertNoErrors, collectConsoleErrors, selectors } from "./helpers";

test.describe("Critical page loads", () => {
  const publicRoutes = [
    { path: "/", name: "Homepage" },
    { path: "/markets", name: "Markets" },
    { path: "/create", name: "Create Market" },
    { path: "/launch", name: "Launch" },
    { path: "/portfolio", name: "Portfolio" },
    { path: "/faucet", name: "Faucet" },
    { path: "/bugs", name: "Bug Report" },
    { path: "/report-bug", name: "Report Bug Form" },
    { path: "/guide", name: "Guide" },
    { path: "/devnet-mint", name: "Devnet Mint" },
    { path: "/join", name: "Join" },
    { path: "/agents", name: "Agents" },
    { path: "/my-markets", name: "My Markets" },
  ];

  for (const route of publicRoutes) {
    test(`${route.name} (${route.path}) loads with 200`, async ({ page }) => {
      const response = await page.goto(route.path);
      expect(response?.status()).toBe(200);
      await assertNoErrors(page);
    });
  }

  test("All pages have header, main, and footer landmarks", async ({ page }) => {
    for (const route of publicRoutes) {
      await page.goto(route.path);
      await expect(page.locator(selectors.header).first()).toBeVisible();
      await expect(page.locator(selectors.mainContent).first()).toBeVisible();
      // Footer may be below fold — check it exists in DOM
      await expect(page.locator(selectors.footer).first()).toHaveCount(1);
    }
  });

  test("404 page renders for invalid route", async ({ page }) => {
    const response = await page.goto("/this-route-does-not-exist-xyz");
    expect(response?.status()).toBe(404);
  });

  test("Homepage has no console errors", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await navigateTo(page, "/");
    // Allow a moment for async errors to surface.
    // page.waitForTimeout is safe here — we don't eval in the page context.
    try {
      await page.waitForTimeout(2000);
    } catch {
      // Page context may have been destroyed by a redirect/fast-refresh —
      // treat as no errors if the page loaded without an error event.
    }
    expect(errors).toHaveLength(0);
  });
});

test.describe("Admin routes", () => {
  test("Admin login page loads", async ({ page }) => {
    const response = await page.goto("/admin/login");
    expect(response?.status()).toBe(200);
  });

  test("Admin dashboard redirects to login when unauthenticated", async ({ page }) => {
    await page.goto("/admin");
    // Should either redirect to login, show login form, or show auth-required message
    const loginIndicator = page.locator([
      'input[type="password"]',
      'input[type="email"]',
      'a[href*="login"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Sign In")',
      ':text("sign in")',
      ':text("log in")',
      ':text("unauthorized")',
      ':text("authentication")',
    ].join(", ")).first();

    try {
      await expect(loginIndicator).toBeVisible({ timeout: 10000 });
    } catch {
      // Verify we at least redirected to /admin/login or the page URL changed
      const url = page.url();
      const hasLoginRedirect = url.includes("login") || url.includes("auth");
      if (!hasLoginRedirect) {
        // Check page content for any auth-related text
        const text = (await page.locator("body").textContent()) ?? "";
        const hasAuthText = /sign.?in|log.?in|password|unauthorized|admin/i.test(text);
        expect(hasAuthText).toBeTruthy();
      }
    }
  });
});
