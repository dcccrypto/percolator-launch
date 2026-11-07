/**
 * The price-WS URL (the display-price feed), configurable at RUNTIME.
 *
 * Council 2026-11-06-go1106-ux, Operator (med): the preview's price-WS sits behind a Cloudflare quick tunnel whose
 * random URL changes on every restart, while the URL was baked into the client at build time via NEXT_PUBLIC_WS_URL.
 * One tunnel restart froze ticking prices until someone changed the env and rebuilt.
 *
 * Now:
 *   server  resolveServerPriceWsUrl(process.env) at request time: PRICE_WS_URL (a plain server env var, never inlined
 *           into a bundle), else the build-time NEXT_PUBLIC_WS_URL. Used by /api/runtime-config and the middleware's
 *           CSP connect-src, so the socket the browser opens is also the one the CSP allows.
 *   browser getPriceWsUrl(): the value /api/runtime-config set on window before hydration (app/layout.tsx loads it
 *           with strategy="beforeInteractive"), else the build-time NEXT_PUBLIC_WS_URL.
 * With PRICE_WS_URL unset everything resolves exactly as before. Only wss:// URLs (and ws:// to a local server) are
 * accepted; anything else counts as unset.
 */

/** window[PRICE_WS_RUNTIME_GLOBAL] = { priceWsUrl } — set by /api/runtime-config. */
export const PRICE_WS_RUNTIME_GLOBAL = "__PERCOLATOR_RUNTIME__";

/** Path of the runtime-config script (app/api/runtime-config/route.ts). */
export const RUNTIME_CONFIG_PATH = "/api/runtime-config";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A usable price-WS URL, trimmed, or null. */
export function normalizePriceWsUrl(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password || !u.hostname) return null;
  if (u.protocol === "wss:") return v;
  if (u.protocol === "ws:" && LOCAL_HOSTS.has(u.hostname)) return v;
  return null;
}

/** Server, per request. `env` is passed in so tests (and the middleware) say exactly what they read. */
export function resolveServerPriceWsUrl(env: Record<string, string | undefined>): string {
  return normalizePriceWsUrl(env.PRICE_WS_URL) ?? normalizePriceWsUrl(env.NEXT_PUBLIC_WS_URL) ?? "";
}

/** The body of /api/runtime-config: sets a frozen config object on window. `<` is escaped so it can't close a tag. */
export function runtimeConfigScript(priceWsUrl: string): string {
  const json = JSON.stringify({ priceWsUrl }).replace(/</g, "\\u003c");
  return `window[${JSON.stringify(PRICE_WS_RUNTIME_GLOBAL)}]=Object.freeze(${json});`;
}

/**
 * Browser (and any client module): the runtime value when the server handed one over (an explicit "" means the feed
 * is off), else the build-time NEXT_PUBLIC_WS_URL. Call it when connecting, not at module load of a server bundle.
 */
export function getPriceWsUrl(): string {
  if (typeof window !== "undefined") {
    const cfg = (window as unknown as Record<string, unknown>)[PRICE_WS_RUNTIME_GLOBAL];
    if (cfg && typeof cfg === "object" && typeof (cfg as { priceWsUrl?: unknown }).priceWsUrl === "string") {
      const v = (cfg as { priceWsUrl: string }).priceWsUrl;
      if (v === "") return "";
      const ok = normalizePriceWsUrl(v);
      if (ok) return ok;
    }
  }
  // Literal access so Next inlines the build-time value into client bundles.
  return process.env.NEXT_PUBLIC_WS_URL ?? "";
}
