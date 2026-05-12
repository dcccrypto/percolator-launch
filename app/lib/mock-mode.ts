/**
 * Mock mode utilities for dev-only UI testing.
 * Mock mode is active when ANY of these are true:
 *   1. NEXT_PUBLIC_MOCK_MODE === "true" (build-time opt-in)
 *   2. URL contains ?mock=1 (per-request opt-in, client-only) — used by
 *      /demo-shots to capture authentic UI screenshots without flipping
 *      mock mode for the whole site.
 *
 * The URL-param branch only runs in the browser, which means SSR will
 * render as non-mock and the client will re-render with mock data on
 * the next pass. That triggers a React hydration warning but is harmless
 * for the screenshot use case (founder-only). Do not rely on the
 * URL-param path for production end-user routes.
 */

export function isMockMode(): boolean {
  const envFlag = process.env.NEXT_PUBLIC_MOCK_MODE;
  if (envFlag === "true" || envFlag === "1") return true;

  // Client-only URL-param check
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mock") === "1") return true;
  }

  return false;
}
