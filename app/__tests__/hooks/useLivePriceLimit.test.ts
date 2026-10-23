/**
 * #3320 (client shape from @0x-SquidSol's #3325): the pre-check reads only the caller's own
 * verdict, with the Privy session headers, and every failure is "unknown" (fails open).
 */
import { describe, it, expect, vi } from "vitest";
import { blocksNewLaunch, fetchLivePriceLimit, parseLimit } from "@/hooks/useLivePriceLimit";
import { LIVE_PRICE_LIMIT_COPY } from "@/lib/wizard-copy";

const W = "7Q3CVASeMNyYX4Q5zc7xCNhiCPZeSoMNLnYACUBR5qeQ";
const headers = async () => ({ Authorization: "Bearer a", "x-privy-id-token": "i" });
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("parseLimit", () => {
  it("reads only a boolean atLimit", () => {
    expect(parseLimit({ atLimit: true })).toBe("atLimit");
    expect(parseLimit({ atLimit: false })).toBe("ok");
    for (const bad of [null, {}, { atLimit: "true" }, { atLimit: 1 }, []]) expect(parseLimit(bad)).toBe("unknown");
  });
});

describe("fetchLivePriceLimit", () => {
  it("sends the Privy session headers and the wallet, and returns the verdict", async () => {
    const f = reply({ atLimit: true });
    expect(await fetchLivePriceLimit(W, headers, f)).toBe("atLimit");
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`/api/playground/keeper-capacity?wallet=${W}`);
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer a", "x-privy-id-token": "i" });
  });

  it("FAIL OPEN: no Privy provider / signed-out session sends nothing and is unknown", async () => {
    const f = reply({ atLimit: true });
    expect(await fetchLivePriceLimit(W, null, f)).toBe("unknown");
    expect(await fetchLivePriceLimit(W, async () => null, f)).toBe("unknown");
    expect(f).not.toHaveBeenCalled();
  });

  it("FAIL OPEN: 401 / 403 / 429 / 503, a network error and a thrown header getter are all unknown", async () => {
    for (const s of [401, 403, 429, 503]) expect(await fetchLivePriceLimit(W, headers, reply({ atLimit: true }, s))).toBe("unknown");
    expect(await fetchLivePriceLimit(W, headers, vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe("unknown");
    expect(await fetchLivePriceLimit(W, async () => { throw new Error("privy"); }, reply({ atLimit: true }))).toBe("unknown");
  });
});

describe("blocksNewLaunch", () => {
  it("blocks a new keeper-priced launch at a known limit", () => {
    expect(blocksNewLaunch("atLimit", { keeperPriced: true, resuming: false })).toBe(true);
  });
  it("never blocks below the limit, on unknown, a non-keeper market, or a launch being continued", () => {
    expect(blocksNewLaunch("ok", { keeperPriced: true, resuming: false })).toBe(false);
    expect(blocksNewLaunch("unknown", { keeperPriced: true, resuming: false })).toBe(false);
    expect(blocksNewLaunch("atLimit", { keeperPriced: false, resuming: false })).toBe(false);
    expect(blocksNewLaunch("atLimit", { keeperPriced: true, resuming: true })).toBe(false);
  });
});

describe("copy", () => {
  it("is one calm line with no digits or jargon", () => {
    expect(LIVE_PRICE_LIMIT_COPY).not.toMatch(/\d|maintainer|keeper|slab|cap\b/i);
    expect(LIVE_PRICE_LIMIT_COPY).not.toContain("\n");
  });
});
