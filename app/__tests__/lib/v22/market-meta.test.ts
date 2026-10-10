// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { parseV22MarketMeta, v22MarketMetaFromEnv, V22_MARKETS_MAX } from "@/lib/v22/market-meta";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const key = (): string => Keypair.generate().publicKey.toBase58();
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slab: key(),
  symbol: "SOL",
  name: "Solana",
  mainnet_ca: key(),
  dex_pool_address: key(),
  lp_portfolio_address: key(),
  ...over,
});

describe("v2.2 env market list: parser", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses valid entries keyed by slab, dropping unknown fields", () => {
    const a = entry({ matcher_context: key() });
    const b = entry({ symbol: "JUP", name: "Jupiter" });
    const out = parseV22MarketMeta(JSON.stringify([a, b]));
    expect(Object.keys(out)).toEqual([a.slab, b.slab]);
    expect(out[a.slab as string]).toEqual({
      symbol: "SOL",
      name: "Solana",
      mainnet_ca: a.mainnet_ca,
      dex_pool_address: a.dex_pool_address,
      lp_portfolio_address: a.lp_portfolio_address,
    });
  });

  it("returns {} for unset, blank, non-JSON, non-array and oversized input", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseV22MarketMeta(undefined)).toEqual({});
    expect(parseV22MarketMeta("  ")).toEqual({});
    expect(parseV22MarketMeta("{not json")).toEqual({});
    expect(parseV22MarketMeta(JSON.stringify(entry()))).toEqual({});
    const many = Array.from({ length: V22_MARKETS_MAX + 1 }, () => entry());
    expect(parseV22MarketMeta(JSON.stringify(many))).toEqual({});
  });

  it("skips bad entries and keeps the good ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = entry();
    const dup = { ...entry(), slab: good.slab };
    const bad = [
      null,
      "x",
      entry({ slab: "not-a-key" }),
      entry({ lp_portfolio_address: undefined }),
      entry({ mainnet_ca: ` ${key()}x` }),
      entry({ symbol: "" }),
      entry({ symbol: "A".repeat(17) }),
      entry({ name: "<script>" }),
      entry({ name: "bad\nname" }),
    ];
    const out = parseV22MarketMeta(JSON.stringify([good, ...bad, dup]));
    expect(Object.keys(out)).toEqual([good.slab]);
    expect(out[good.slab as string].symbol).toBe("SOL");
    expect(warn).toHaveBeenCalledTimes(bad.length + 1);
  });
});

describe("v2.2 env market list: gating", () => {
  afterEach(() => {
    __setDevnetV22ForTest(null);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is empty with the v2.2 flag off, even when the variable is set", () => {
    vi.stubEnv("NEXT_PUBLIC_V22_MARKETS_JSON", JSON.stringify([entry()]));
    __setDevnetV22ForTest(false);
    expect(v22MarketMetaFromEnv()).toEqual({});
  });

  it("is empty on a mainnet build, even with the flag on", () => {
    vi.stubEnv("NEXT_PUBLIC_V22_MARKETS_JSON", JSON.stringify([entry()]));
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    __setDevnetV22ForTest(true);
    expect(v22MarketMetaFromEnv()).toEqual({});
  });

  it("flag on + devnet: the markets become curated PLAYGROUND_SLAB_META entries (list, metadata, LP pin)", async () => {
    const e = entry({ symbol: "PERC", name: "Percolator" });
    vi.stubEnv("NEXT_PUBLIC_V22_MARKETS_JSON", JSON.stringify([e]));
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
    vi.resetModules();
    const { PLAYGROUND_SLAB_META } = await import("@/lib/playground-slab-meta");
    expect(PLAYGROUND_SLAB_META[e.slab as string]).toMatchObject({
      symbol: "PERC",
      name: "Percolator",
      lp_portfolio_address: e.lp_portfolio_address,
    });
    const { getKnownLpPortfolioAddress } = await import("@/lib/lp-portfolio");
    expect(getKnownLpPortfolioAddress(e.slab as string)).toBe(e.lp_portfolio_address);
  });

  it("flag off: PLAYGROUND_SLAB_META is exactly the static table (playground unchanged)", async () => {
    vi.stubEnv("NEXT_PUBLIC_V22_MARKETS_JSON", JSON.stringify([entry()]));
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "");
    vi.resetModules();
    const { PLAYGROUND_SLAB_META } = await import("@/lib/playground-slab-meta");
    expect(PLAYGROUND_SLAB_META).toEqual({});
  });
});
