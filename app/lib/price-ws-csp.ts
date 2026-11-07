/**
 * CSP connect-src entries for the configured price-WS service, v22price 2026-10-22.
 *
 * The CSP only allowed the price-WS on Railway (wss://*.up.railway.app). A deployment whose price stream lives
 * elsewhere (the v2.2 preview's Mac-mini price-ws behind a tunnel) had its socket silently blocked by the browser:
 * the chart sat at "Offline" and prices stayed on the REST/on-chain seed. This allows EXACTLY the configured origin,
 * as the socket origin plus its http(s) twin (the /ticks gap-repair fetch, lib/chart/live-client.ts).
 *
 * Council council-leftovers run 2, #2: "accept" and "allow" used two predicates (ws://localhost was accepted and served
 * by /api/runtime-config but never allowed here in production). The entries are now built from the output of the one
 * predicate, `normalizePriceWsUrl` (lib/price-ws-url.ts): whatever it accepts is allowed, whatever it refuses adds
 * nothing. In production that means wss:// only.
 */
import { normalizePriceWsUrl } from "@/lib/price-ws-url";

export function priceWsConnectSrc(raw: string | undefined, opts: { allowLocalWs?: boolean } = {}): string {
  const ok = normalizePriceWsUrl(raw, opts);
  if (!ok) return "";
  const u = new URL(ok);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return u.protocol === "wss:" ? `wss://${host} https://${host} ` : `ws://${host} http://${host} `;
}
