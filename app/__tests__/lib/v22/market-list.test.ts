// @vitest-environment node
/**
 * v2.2 preview market list (QA PF-5 / UX-8): multi-asset markets are hidden from listings from the on-chain config,
 * `withdraw_only` comes through the env list, and a real 3-letter ticker that starts its vanity token CA is a name,
 * not a placeholder. The slab fixtures are the raw devnet accounts (captured 2026-10-14).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { readMaxPortfolioAssets } from "@/lib/v17-engine-config";
import { isBrowsableMarketRow, isListedMarketRow, isMultiAssetMarket, isWithdrawOnlyMarket } from "@/lib/listed-markets";
import { isListedMarket } from "@/lib/market-visibility";
import { isPlaceholderMarketName, isPlaceholderMarketSymbol } from "@/lib/symbol-utils";
import { parseV22MarketMeta } from "@/lib/v22/market-meta";

const load = (name: string): Uint8Array => {
  const f = JSON.parse(readFileSync(join(__dirname, "..", "..", "fixtures", name), "utf-8")) as { dataBase64: string };
  return new Uint8Array(Buffer.from(f.dataBase64, "base64"));
};
const SINGLE = load("v22-market-single-asset-SOL.json"); // BYFuWyuo…, 4,059 B
const MULTI = load("v22-market-multi-asset-2xhs.json"); // 2xhsLP9N…, capacity 5, max 4 assets

afterEach(() => {
  __setDevnetV22ForTest(null);
  vi.restoreAllMocks();
});

describe("readMaxPortfolioAssets (on-chain config, not a slab list)", () => {
  it("reads 1 on a real single-asset market and 4 on the real multi-asset test market", () => {
    __setDevnetV22ForTest(true);
    expect(readMaxPortfolioAssets(SINGLE)).toBe(1);
    expect(readMaxPortfolioAssets(MULTI)).toBe(4);
  });

  it("is null for an account too short to hold it", () => {
    __setDevnetV22ForTest(true);
    expect(readMaxPortfolioAssets(new Uint8Array(100))).toBeNull();
  });
});

describe("listing predicates", () => {
  const stats = { last_price: 100, total_open_interest: 1, vault_balance: 5, c_tot: 5, total_accounts: 2, volume_24h: 1 };
  const slab = Keypair.generate().publicKey.toBase58();

  it("multi-asset (> 1) is hidden from /markets, the rail, the picker and the dashboard count; 1 and unread are shown", () => {
    const multi = { ...stats, max_portfolio_assets: 4 };
    const single = { ...stats, max_portfolio_assets: 1 };
    expect(isMultiAssetMarket(multi)).toBe(true);
    expect(isMultiAssetMarket(single)).toBe(false);
    expect(isMultiAssetMarket(stats)).toBe(false); // unread degrades to shown
    expect(isListedMarketRow(slab, multi)).toBe(false);
    expect(isBrowsableMarketRow(slab, multi)).toBe(false);
    expect(isListedMarket({ ...multi, slab_address: slab })).toBe(false);
    expect(isListedMarketRow(slab, single)).toBe(true);
    expect(isBrowsableMarketRow(slab, single)).toBe(true);
    expect(isListedMarket({ ...single, slab_address: slab })).toBe(true);
    expect(isListedMarketRow(slab, stats)).toBe(true);
  });

  it("withdraw_only is only an explicit true", () => {
    expect(isWithdrawOnlyMarket({ withdraw_only: true })).toBe(true);
    expect(isWithdrawOnlyMarket({ withdraw_only: "true" })).toBe(false);
    expect(isWithdrawOnlyMarket({})).toBe(false);
  });
});

describe("env list: withdraw_only", () => {
  const k = (): string => Keypair.generate().publicKey.toBase58();
  const e = (over: Record<string, unknown>) => ({ slab: k(), symbol: "JUP-OLD", name: "JUP (old)", mainnet_ca: k(), dex_pool_address: k(), lp_portfolio_address: k(), ...over });

  it("carries withdraw_only: true through, omits it otherwise, rejects a non-boolean entry", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = e({ withdraw_only: true });
    const b = e({});
    const c = e({ withdraw_only: "yes" });
    const out = parseV22MarketMeta(JSON.stringify([a, b, c]));
    expect(out[a.slab]?.withdraw_only).toBe(true);
    expect(out[b.slab] && "withdraw_only" in out[b.slab]).toBe(false);
    expect(out[c.slab]).toBeUndefined();
  });
});

describe("market symbol placeholder rule (UX-8: JUP shows JUP/USD, not the slab address)", () => {
  const JUP_CA = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const SLAB = "GtUe5hYy8scuMsp2cmXt7WfCfqKVgTJ8RjuTyvz3MB8B";
  const addrs = [SLAB, "ERe2nVetnKFH4Am7hh1cVWXd52s7uhWjorwFkU61kwan", JUP_CA];

  it("a real 3-letter ticker that starts its vanity token CA is a symbol and a name", () => {
    expect(isPlaceholderMarketSymbol("JUP", addrs)).toBe(false);
    expect(isPlaceholderMarketSymbol("JUP-OLD", addrs)).toBe(false);
    expect(isPlaceholderMarketName("JUP", addrs)).toBe(false);
  });

  it("generated placeholders are still caught: 4-8 char address prefixes, hex, truncations, empty", () => {
    expect(isPlaceholderMarketSymbol("JUPy", addrs)).toBe(true);
    expect(isPlaceholderMarketSymbol("JUPyiwrY", addrs)).toBe(true);
    expect(isPlaceholderMarketSymbol("GtUe5h", addrs)).toBe(true);
    expect(isPlaceholderMarketSymbol("a1b2c3d4", addrs)).toBe(true);
    expect(isPlaceholderMarketSymbol("GtUe...3B8B", addrs)).toBe(true);
    expect(isPlaceholderMarketSymbol("", addrs)).toBe(true);
    expect(isPlaceholderMarketName("JUPyiwrY", addrs)).toBe(true);
    expect(isPlaceholderMarketName("Market GtUe5hYy", addrs)).toBe(true);
  });
});
