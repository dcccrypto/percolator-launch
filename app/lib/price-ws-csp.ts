/**
 * CSP connect-src entries for the configured price-WS service (NEXT_PUBLIC_WS_URL), v22price 2026-10-22.
 *
 * The CSP only allowed the price-WS on Railway (wss://*.up.railway.app). A deployment whose price stream lives
 * elsewhere (the v2.2 preview's Mac-mini price-ws behind a tunnel) had its socket silently blocked by the browser:
 * the chart sat at "Offline" and prices stayed on the REST/on-chain seed. This allows EXACTLY the configured origin,
 * as `wss://host` (the socket) plus `https://host` (the /ticks gap-repair fetch, lib/chart/live-client.ts), and only
 * for a well-formed wss:// URL. Anything else (unset, ws://, malformed) adds nothing.
 */
export function priceWsConnectSrc(raw: string | undefined): string {
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  if (u.protocol !== "wss:" || !u.hostname || u.username || u.password) return "";
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return `wss://${host} https://${host} `;
}
