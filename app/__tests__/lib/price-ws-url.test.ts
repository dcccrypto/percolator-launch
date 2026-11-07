/**
 * Council 2026-11-06-go1106-ux, Operator (med): "The display-price path depends on a Cloudflare QUICK tunnel. Its
 * random URL changes on any cloudflared or launchd restart, but the URL is baked into the client at build time via
 * NEXT_PUBLIC_WS_URL. One reboot or tunnel crash freezes ticking prices on the preview until someone updates the env
 * and redeploys."
 *
 * The price-WS URL is now resolved on the SERVER at request time (PRICE_WS_URL, a plain runtime env var that is never
 * inlined into a bundle), handed to the browser by /api/runtime-config before hydration, and read by every client
 * caller through getPriceWsUrl(). NEXT_PUBLIC_WS_URL stays the build-time fallback, so nothing changes until
 * PRICE_WS_URL is set.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PRICE_WS_RUNTIME_GLOBAL,
  getPriceWsUrl,
  normalizePriceWsUrl,
  resolveServerPriceWsUrl,
  runtimeConfigScript,
} from "../../lib/price-ws-url";

type W = Record<string, unknown>;
afterEach(() => {
  delete (window as unknown as W)[PRICE_WS_RUNTIME_GLOBAL];
});

describe("normalizePriceWsUrl", () => {
  it("accepts wss:// URLs (the tunnel / Railway case), trimmed", () => {
    expect(normalizePriceWsUrl(" wss://unnecessary-lime-whom-negotiations.trycloudflare.com ")).toBe(
      "wss://unnecessary-lime-whom-negotiations.trycloudflare.com",
    );
  });
  it("accepts ws:// only for a local server", () => {
    expect(normalizePriceWsUrl("ws://localhost:8787")).toBe("ws://localhost:8787");
    expect(normalizePriceWsUrl("ws://127.0.0.1:8797")).toBe("ws://127.0.0.1:8797");
    expect(normalizePriceWsUrl("ws://price.example.com")).toBeNull();
  });
  it("refuses anything else: other schemes, credentials, garbage, empty", () => {
    for (const v of ["https://price.example.com", "javascript:alert(1)", "wss://u:p@price.example.com", "not a url", "", undefined]) {
      expect(normalizePriceWsUrl(v as string | undefined), String(v)).toBeNull();
    }
  });
});

describe("resolveServerPriceWsUrl (request time)", () => {
  it("prefers the runtime PRICE_WS_URL over the build-time NEXT_PUBLIC_WS_URL", () => {
    expect(resolveServerPriceWsUrl({ PRICE_WS_URL: "wss://new.trycloudflare.com", NEXT_PUBLIC_WS_URL: "wss://old.trycloudflare.com" })).toBe(
      "wss://new.trycloudflare.com",
    );
  });
  it("falls back to NEXT_PUBLIC_WS_URL when PRICE_WS_URL is unset or invalid", () => {
    expect(resolveServerPriceWsUrl({ NEXT_PUBLIC_WS_URL: "wss://old.trycloudflare.com" })).toBe("wss://old.trycloudflare.com");
    expect(resolveServerPriceWsUrl({ PRICE_WS_URL: "http://nope", NEXT_PUBLIC_WS_URL: "wss://old.trycloudflare.com" })).toBe(
      "wss://old.trycloudflare.com",
    );
  });
  it("is empty (WS disabled) when neither is set", () => {
    expect(resolveServerPriceWsUrl({})).toBe("");
  });
});

describe("runtimeConfigScript", () => {
  it("assigns a frozen config object on window with the URL", () => {
    const js = runtimeConfigScript("wss://new.trycloudflare.com");
    new Function(js)(); // runs against jsdom's window
    expect((window as unknown as W)[PRICE_WS_RUNTIME_GLOBAL]).toEqual({ priceWsUrl: "wss://new.trycloudflare.com" });
    expect(Object.isFrozen((window as unknown as W)[PRICE_WS_RUNTIME_GLOBAL])).toBe(true);
  });
  it("cannot be broken out of (a URL is validated first, and < is escaped anyway)", () => {
    const js = runtimeConfigScript("wss://x.example.com/</script><script>alert(1)</script>");
    expect(js).not.toMatch(/<\/script>/i);
  });
});

describe("getPriceWsUrl (browser)", () => {
  it("uses the runtime value the server handed over", () => {
    (window as unknown as W)[PRICE_WS_RUNTIME_GLOBAL] = { priceWsUrl: "wss://new.trycloudflare.com" };
    expect(getPriceWsUrl()).toBe("wss://new.trycloudflare.com");
  });
  it("an explicit empty runtime value means disabled, not 'fall back'", () => {
    (window as unknown as W)[PRICE_WS_RUNTIME_GLOBAL] = { priceWsUrl: "" };
    expect(getPriceWsUrl()).toBe("");
  });
  it("without a runtime value it is the build-time NEXT_PUBLIC_WS_URL (unchanged behaviour)", () => {
    const prev = process.env.NEXT_PUBLIC_WS_URL;
    process.env.NEXT_PUBLIC_WS_URL = "wss://build.example.com";
    try {
      expect(getPriceWsUrl()).toBe("wss://build.example.com");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
      else process.env.NEXT_PUBLIC_WS_URL = prev;
    }
  });
  it("ignores a malformed runtime value", () => {
    (window as unknown as W)[PRICE_WS_RUNTIME_GLOBAL] = { priceWsUrl: "javascript:alert(1)" };
    const prev = process.env.NEXT_PUBLIC_WS_URL;
    process.env.NEXT_PUBLIC_WS_URL = "";
    try {
      expect(getPriceWsUrl()).toBe("");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
      else process.env.NEXT_PUBLIC_WS_URL = prev;
    }
  });
});
