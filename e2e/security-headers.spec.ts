/**
 * E2E Suite 7: Security Headers & CSP
 *
 * Verifies security headers are set correctly on responses:
 * - Content-Security-Policy is present and well-formed
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY (or SAMEORIGIN on Vercel preview)
 * - Referrer-Policy set
 * - No leaked secrets or sensitive data in page source
 *
 * PERC-010 / Issue #245
 */

import { test, expect } from "@playwright/test";

test.describe("Security headers", () => {
  test("CSP header is present on page responses", async ({ page }) => {
    const response = await page.goto("/");
    const headers = response?.headers();
    const csp = headers?.["content-security-policy"];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src");
    expect(csp).toContain("script-src");
  });

  test("CSP includes nonce for scripts", async ({ page }) => {
    const response = await page.goto("/");
    const csp = response?.headers()?.["content-security-policy"] ?? "";
    // CSP should contain a nonce directive
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  test("X-Content-Type-Options is nosniff", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.headers()?.["x-content-type-options"]).toBe("nosniff");
  });

  test("X-Frame-Options blocks framing", async ({ page }) => {
    const response = await page.goto("/");
    const value = response?.headers()?.["x-frame-options"];
    // Config sets DENY, but Vercel preview overrides to SAMEORIGIN for its
    // dashboard iframe. Both are acceptable clickjacking protections.
    expect(value).toMatch(/^(DENY|SAMEORIGIN)$/);
  });

  test("Referrer-Policy is set", async ({ page }) => {
    const response = await page.goto("/");
    const referrer = response?.headers()?.["referrer-policy"];
    expect(referrer).toBeTruthy();
    expect(referrer).toContain("origin");
  });

  test("Permissions-Policy is restrictive", async ({ page }) => {
    const response = await page.goto("/");
    const perms = response?.headers()?.["permissions-policy"];
    expect(perms).toBeTruthy();
    expect(perms).toContain("camera=()");
    expect(perms).toContain("microphone=()");
  });
});

test.describe("No leaked secrets", () => {
  test("page source does not contain private keys or secrets", async ({ page }) => {
    await page.goto("/");
    const html = await page.content();
    const lowerHtml = html.toLowerCase();

    // Should not contain any private key patterns
    expect(lowerHtml).not.toContain("private_key");
    expect(lowerHtml).not.toContain("secret_key");
    expect(lowerHtml).not.toContain("supabase_service_role");
    // No raw Solana private key (base58, 88 chars)
    expect(html).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,89}/);
  });

  test("API responses do not leak server config", async ({ page }) => {
    // Try to access a known API endpoint
    const response = await page.goto("/api/health");
    if (response && response.status() === 200) {
      const body = await response.text();
      const lower = body.toLowerCase();
      expect(lower).not.toContain("database_url");
      expect(lower).not.toContain("supabase_service");
    }
  });
});
