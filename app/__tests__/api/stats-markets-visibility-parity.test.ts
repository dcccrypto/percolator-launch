/**
 * GH#2705: /api/stats counted markets /api/markets hides (25 vs 20 live), and
 * summed their OI ($3.6K) and 24h volume ($2.7K) into the dashboard totals.
 *
 * Mechanism: /api/stats rebuilt the list's visibility rule by hand and mirrored
 * only the zombie half; markets whose creation provably never finished
 * (is_complete === false — marketauth never rotated to the stake-pool PDA) are
 * dropped by /api/markets but were counted by /api/stats.
 *
 * Calls the REAL route handlers over the SAME mocked registry rows and derives
 * the /markets page's "All Markets" set with the REAL client filter
 * (isListedMarketRow), so the test exercises the code that runs.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { isListedMarketRow } from "@/lib/listed-markets";
import { isListedMarket, isProvenIncompleteMarket } from "@/lib/market-visibility";

const SI = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx"; // lib/listing-hidden DEFAULT_HIDDEN

// Two complete, live markets (shapes from the GH#2676 live rows).
const COMPLETE = [
  { slab_address: "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ", symbol: "COLLECT", decimals: 6, last_price: 0.019281, volume_24h: 85420329419, trade_count_24h: 6, vault_balance: 2099892986, c_tot: 1388510895, total_accounts: 4, total_open_interest: 55705224804, total_open_interest_usd: 1074.05, is_complete: true, oracle_mode: "admin" },
  { slab_address: "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr", symbol: "SOL", decimals: 9, last_price: 117.086498, volume_24h: 3396789, trade_count_24h: 3, vault_balance: 51529591886, c_tot: 51482375164, total_accounts: 3, total_open_interest: 0, total_open_interest_usd: 0, is_complete: true, oracle_mode: "admin" },
];

// The rows the issue identified on chain: marketauth never rotated, so the
// live merge reports is_complete === false — yet they carry OI, volume, trades.
const INCOMPLETE = [
  { slab_address: "8XwbXQ6oZ1JEnwFXsuS3AqYEYV17Msmd7hv2VUxjLbfR", symbol: "INC1", decimals: 6, last_price: 9000, volume_24h: 100000, trade_count_24h: 1, vault_balance: 5_000_000_000, c_tot: 4_000_000_000, total_accounts: 2, total_open_interest: 200000, total_open_interest_usd: 1800, is_complete: false, oracle_mode: "admin" },
  { slab_address: "8zTWNoYrWgBdSnGCabL2ZqBtWjqq4qAwy9kVaN3582pL", symbol: "INC2", decimals: 6, last_price: 9000, volume_24h: 100000, trade_count_24h: 1, vault_balance: 5_000_000_000, c_tot: 4_000_000_000, total_accounts: 2, total_open_interest: 200000, total_open_interest_usd: 1800, is_complete: false, oracle_mode: "admin" },
  { slab_address: "FQHF251LayhfnspwVukKsEckcW8t4ysBovu9HTfEsxty", symbol: "INC3", decimals: 6, last_price: 9000, volume_24h: 100000, trade_count_24h: 1, vault_balance: 5_000_000_000, c_tot: 4_000_000_000, total_accounts: 2, total_open_interest: 0, total_open_interest_usd: 0, is_complete: false, oracle_mode: "admin" },
];

// Listing-hidden (SI): served by /api/markets so holders can exit, but not
// listed on /markets — so not counted by the dashboard either.
const HIDDEN = { slab_address: SI, symbol: "SI", decimals: 6, last_price: 2, volume_24h: 1_000_000, trade_count_24h: 2, vault_balance: 3_000_000_000, c_tot: 2_000_000_000, total_accounts: 2, total_open_interest: 1_000_000, total_open_interest_usd: 2, is_complete: true, oracle_mode: "admin" };

// A zombie (drained vault) — already excluded by both before the fix.
const ZOMBIE = { slab_address: "HGBsy58VYi3zv2wooviCruhkAo5NWhCD54xDqWSALywU", symbol: "ZMB", decimals: 6, last_price: null, volume_24h: 0, trade_count_24h: 0, vault_balance: 0, c_tot: 0, total_accounts: 0, total_open_interest: 0, total_open_interest_usd: 0, is_complete: true, oracle_mode: "admin" };

const ROWS = [...COMPLETE, ...INCOMPLETE, HIDDEN, ZOMBIE];

const mocks = vi.hoisted(() => ({ loadMergedMarketRows: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: mocks.loadMergedMarketRows, MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com", programId: "11111111111111111111111111111112" })),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: vi.fn() }));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }),
}));

import { GET as statsGET } from "@/app/api/stats/route";
import { GET as marketsGET } from "@/app/api/markets/route";

const fresh = () => ROWS.map((r) => ({ ...r }));

async function callStats(): Promise<Record<string, number | null | boolean>> {
  mocks.loadMergedMarketRows.mockResolvedValue(fresh());
  const res = await statsGET(new NextRequest("http://localhost/api/stats"));
  return (await res.json()) as Record<string, number | null | boolean>;
}

async function callMarkets(qs = ""): Promise<{ total: number; markets: Array<Record<string, unknown>> }> {
  mocks.loadMergedMarketRows.mockResolvedValue(fresh());
  const res = await marketsGET(new NextRequest(`http://localhost/api/markets${qs}`));
  return (await res.json()) as { total: number; markets: Array<Record<string, unknown>> };
}

/** What the /markets page lists as "All Markets" (app/markets/page.tsx activeMarkets). */
async function marketsPageListed(): Promise<Array<Record<string, unknown>>> {
  const body = await callMarkets("?include_zombie=true&limit=500");
  return body.markets.filter((m) => isListedMarketRow(m.slab_address as string, m));
}

describe("GH#2705 /api/stats counts exactly the markets the /markets page lists", () => {
  it("CONTROL: both handlers ran on the mocked rows", async () => {
    const stats = await callStats();
    expect(mocks.loadMergedMarketRows).toHaveBeenCalled();
    expect(stats.live).toBe(true);
    expect(stats.totalTraders).toBeNull(); // identifies the registry (primary) path
    const listed = await marketsPageListed();
    expect(listed.map((m) => m.symbol).sort()).toEqual(["COLLECT", "SOL"]);
  });

  it("market counts equal the /markets page count (incomplete + hidden excluded)", async () => {
    const stats = await callStats();
    const listed = await marketsPageListed();
    expect(stats.totalMarkets).toBe(listed.length);
    expect(stats.totalListedMarkets).toBe(listed.length);
    expect(stats.activeTotal as number).toBeLessThanOrEqual(listed.length);
  });

  it("OI and 24h volume totals equal the sum over the listed rows", async () => {
    const stats = await callStats();
    const listed = await marketsPageListed();
    const oi = listed.reduce((s, r) => s + (Number(r.total_open_interest_usd) || 0), 0);
    const vol = listed.reduce((s, r) => s + (Number(r.volume_24h_usd) || 0), 0);
    const trades = listed.reduce((s, r) => s + (Number(r.trade_count_24h) || 0), 0);
    expect(stats.totalOpenInterest as number).toBeCloseTo(oi, 2);
    expect(stats.totalVolume24h as number).toBeCloseTo(vol, 2);
    expect(stats.trades24h).toBe(trades);
  });

  it("the issue's incomplete rows add nothing: no +$3,600 OI, no +$2,700 volume, no +3 trades", async () => {
    const stats = await callStats();
    // COLLECT 1074.05 OI; SOL 0 OI. Volume: COLLECT 1646.99 + SOL 397.72.
    expect(stats.totalOpenInterest as number).toBeCloseTo(1074.05, 1);
    expect(stats.totalVolume24h as number).toBeCloseTo(2044.71, 1);
    expect(stats.trades24h).toBe(9);
  });
});

describe("GH#2705 /api/markets behaviour is unchanged by the shared predicate", () => {
  it("still drops the proven-incomplete rows and the zombie from its default response", async () => {
    const body = await callMarkets();
    const symbols = body.markets.map((m) => m.symbol).sort();
    expect(symbols).toEqual(["COLLECT", "SI", "SOL"]);
    expect(body.total).toBe(3);
  });

  it("still serves the listing-hidden market so its holders can resolve and exit it", async () => {
    const body = await callMarkets("?include_zombie=true&limit=500");
    expect(body.markets.some((m) => m.slab_address === SI)).toBe(true);
    expect(body.markets.find((m) => m.symbol === "ZMB")?.is_zombie).toBe(true);
  });
});

describe("GH#2705 shared predicate", () => {
  it("is_complete undefined (live state unread) is NOT incomplete — RPC gaps never hide a market", () => {
    const row = { ...COMPLETE[0], is_complete: undefined } as Record<string, unknown>;
    expect(isProvenIncompleteMarket(row)).toBe(false);
    expect(isListedMarket(row)).toBe(true);
  });

  it("excludes incomplete, listing-hidden and zombie rows; keeps complete live ones", () => {
    expect(isListedMarket(INCOMPLETE[0])).toBe(false);
    expect(isListedMarket(HIDDEN)).toBe(false);
    expect(isListedMarket(ZOMBIE)).toBe(false);
    expect(isListedMarket(COMPLETE[0])).toBe(true);
  });

  it("absent reduced-schema keys are 'not mirrored', not zero (no zombie-by-omission)", () => {
    const { vault_balance: _v, c_tot: _c, total_accounts: _a, total_open_interest: _o, ...reduced } = COMPLETE[0];
    expect(isListedMarket(reduced)).toBe(true);
  });
});
