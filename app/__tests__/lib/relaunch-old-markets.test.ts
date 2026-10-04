// @vitest-environment node
/**
 * Relaunch (2026-10-01): the playground moved to all-fresh program IDs, but /api/markets kept
 * listing the 6 pre-relaunch markets (owned by the abandoned wrapper GnwdeQr...). They came from
 * two places: the Supabase registry rows, kept by the curated-slab exemption in
 * PLAYGROUND_SLAB_META. Both are closed here:
 *   - PLAYGROUND_SLAB_META is empty (no curated exemption for an abandoned slab);
 *   - loadMergedMarketRows drops any registry row whose slab is owned by another program
 *     (an unreadable slab keeps the row: an RPC gap must never empty the list);
 *   - /api/markets/[slab] 404s a slab owned by another program.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WRAPPER = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const OLD_WRAPPER = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const FRESH_SLAB = "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy";
const OLD_SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const UNREAD_SLAB = "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg";
const MISTYPED_2988_SLAB = "AcaTmUFncaVEBCvUoR57yWUseJgonUvanWHGYxmXok18";

const m = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  live: new Map<string, Record<string, unknown>>(),
  missing: new Set<string>(),
  unresolved: new Set<string>(),
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: WRAPPER }) }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "not"]) chain[k] = () => chain;
  chain.or = async () => ({ data: m.rows, error: null });
  return { getServiceClient: () => chain, getServerNetwork: () => "devnet" };
});
vi.mock("@/lib/live-market-state", () => ({
  readLiveMarketStateResolutions: async () => ({
    states: m.live,
    missing: m.missing,
    unresolved: m.unresolved,
  }),
}));

import { loadMergedMarketRows } from "@/lib/market-registry";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

const live = (owner: string) => ({ markPriceUsd: 1, oiLongQ: 0, oiShortQ: 0, totalOiQ: 0, totalOiUsd: 0, insurance: 0, vault: 1, cTot: 0, isComplete: true, maxLeverage: 10, owner });

beforeEach(() => {
  m.rows = [
    FRESH_SLAB,
    OLD_SLAB,
    UNREAD_SLAB,
    MISTYPED_2988_SLAB,
  ].map((slab_address) => ({
    slab_address,
    symbol: slab_address.slice(0, 4),
  }));

  m.live = new Map([
    [FRESH_SLAB, live(WRAPPER)],
    [OLD_SLAB, live(OLD_WRAPPER)],
  ]);

  // Confirmed account absence must be hidden.
  m.missing = new Set([MISTYPED_2988_SLAB]);

  // RPC/parse uncertainty must retain the historical fail-open behavior.
  m.unresolved = new Set([UNREAD_SLAB]);
});

describe("relaunch: abandoned-wrapper markets are never listed", () => {
  it("PLAYGROUND_SLAB_META is empty (no curated exemption for a pre-relaunch slab)", () => {
    expect(Object.keys(PLAYGROUND_SLAB_META)).toEqual([]);
  });

  it("drops another-program and confirmed-missing slabs while keeping an unresolved RPC gap", async () => {
    const rows = (
      await loadMergedMarketRows()
    )!.map((r) => r.slab_address);

    expect(rows).toEqual([
      FRESH_SLAB,
      UNREAD_SLAB,
    ]);
  });

  it("NEGATIVE CONTROL: the same slab is retained when unresolved instead of positively missing", async () => {
    m.missing.delete(MISTYPED_2988_SLAB);
    m.unresolved.add(MISTYPED_2988_SLAB);

    const rows = (
      await loadMergedMarketRows()
    )!.map((r) => r.slab_address);

    expect(rows).toContain(MISTYPED_2988_SLAB);
  });

  it("NEGATIVE CONTROL: with the old wrapper's slab read as the current owner, it is listed", async () => {
    m.live.set(OLD_SLAB, live(WRAPPER));
    const rows = (await loadMergedMarketRows())!.map((r) => r.slab_address);
    expect(rows).toContain(OLD_SLAB);
  });

  it("[slab] route: both its on-chain fallback and its registry path refuse another program's slab", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "markets", "[slab]", "route.ts"), "utf8");
    expect(src).toMatch(/info\.owner\.toBase58\(\) !== getConfig\(\)\.programId/);
    expect(src).toMatch(/slabOwnerIfReadable\(String\(data\.slab_address/);
  });

  it("the empty markets list invites the first market", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "markets", "page.tsx"), "utf8");
    expect(src).toContain("No markets yet — create the first one");
    expect(src).toMatch(/href="\/create" data-testid="markets-empty-create"/);
  });
});
