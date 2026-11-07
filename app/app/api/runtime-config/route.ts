/**
 * GET /api/runtime-config — a tiny script that tells the browser the price-WS URL resolved NOW, on the server
 * (lib/price-ws-url.ts). app/layout.tsx loads it with next/script strategy="beforeInteractive", so the price store
 * and charts see it before they connect. Changing PRICE_WS_URL on the server changes what the next page load
 * connects to; no new NEXT_PUBLIC_WS_URL build. The URL is the public display-price feed the browser connects to
 * anyway (it used to be inlined in the JS bundle); nothing secret is served.
 */
import { resolveServerPriceWsUrl, runtimeConfigScript } from "@/lib/price-ws-url";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(runtimeConfigScript(resolveServerPriceWsUrl(process.env)), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
