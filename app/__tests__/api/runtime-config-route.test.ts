// @vitest-environment node
/**
 * /api/runtime-config hands the browser the price-WS URL resolved at REQUEST time (lib/price-ws-url.ts), so a new
 * tunnel URL needs a PRICE_WS_URL change on the server, not a rebuild with a new NEXT_PUBLIC_WS_URL (Council
 * 2026-11-06-go1106-ux, Operator).
 */
import { afterEach, describe, expect, it } from "vitest";

const saved = { PRICE_WS_URL: process.env.PRICE_WS_URL, NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("GET /api/runtime-config", () => {
  it("reads PRICE_WS_URL per request: changing it after the module loaded changes the answer", async () => {
    process.env.NEXT_PUBLIC_WS_URL = "wss://old.trycloudflare.com";
    delete process.env.PRICE_WS_URL;
    const { GET } = await import("@/app/api/runtime-config/route");

    const first = await (await GET()).text();
    expect(first).toContain('"priceWsUrl":"wss://old.trycloudflare.com"');

    process.env.PRICE_WS_URL = "wss://new.trycloudflare.com"; // the tunnel restarted
    const second = await (await GET()).text();
    expect(second).toContain('"priceWsUrl":"wss://new.trycloudflare.com"');
  });

  it("is JavaScript, never cached, and dynamic", async () => {
    const mod = await import("@/app/api/runtime-config/route");
    const res = await mod.GET();
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(mod.dynamic).toBe("force-dynamic");
  });
});
