/**
 * #2990 — the chart's Live PnL badge must not be bound to the DEVICE that
 * opened the position.
 *
 * v17/v18 store no entry price (`account.entryPrice` is structurally 0n —
 * userAccountScan.ts:133, usePortfolio.ts:408), so the entry is reconstructed.
 * This badge used to reconstruct it from the per-browser localStorage cache
 * ALONE and `return null` on a miss. That cache has exactly one production
 * writer — OrderTicket at trade-open time — so a miss is the NORMAL state on
 * any other device: a trader who opened on desktop saw no PnL badge on their
 * phone, while the positions strip on the same screen showed the position and
 * its PnL because it resolves through `resolveEntryPrice`.
 *
 * SCOPE: this file covers the badge only. The Liq and Entry LINES are fixed
 * separately in #2991/#3012 (useLiqPrice.ts, TradingChart.tsx) — deliberately
 * not asserted here, so this file cannot pin behaviour those PRs are changing.
 *
 * Fixture is the reported eacc short with the real numbers from the reporter's
 * desktop fill receipt (13,940.5894 eacc short at $0.013432, mark $0.0133): an
 * on-chain pnl that back-solves to EXACTLY that entry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { resolveEntryPrice } from "@/lib/trading";
import { saveEntryPrice } from "@/lib/entry-price";

const SLAB = "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh";
const OWNER = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const IDX = 0;

const POSITION_SIZE = -1_000_000n; // short
const ORACLE_E6 = 13_330n; // mark  $0.0133
const TRUE_ENTRY_E6 = 13_432n; // entry $0.013432, per the desktop fill receipt
/** on-chain collateral pnl that back-solves to TRUE_ENTRY_E6 exactly. */
const ON_CHAIN_PNL = 102n;
const U64_MAX = 18_446_744_073_709_551_615n;

let zeroPnl = false;
let sentinelPnl = false;

const account = {
  owner: OWNER,
  positionSize: POSITION_SIZE,
  capital: 20_000_000n,
  entryPrice: 0n,
  get pnl() {
    return sentinelPnl ? U64_MAX : zeroPnl ? 0n : ON_CHAIN_PNL;
  },
};

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => ({ idx: IDX, account }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: SLAB,
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    config: { collateralMint: null },
    adlFactors: null,
  }),
}));
vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: () => ({ priceE6: ORACLE_E6, priceUsd: 0.01333 }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));

const { ChartPnlBadge } = await import("@/components/trade/ChartPnlBadge");

/** Any browser other than the one that placed the trade. */
function asSecondDevice() {
  localStorage.clear();
}
/** The browser that placed the trade. */
function asTradingDevice() {
  localStorage.clear();
  saveEntryPrice(SLAB, IDX, TRUE_ENTRY_E6, 5, OWNER.toBase58());
}

describe("ChartPnlBadge resolves its entry like every other position surface", () => {
  beforeEach(() => {
    localStorage.clear();
    zeroPnl = false;
    sentinelPnl = false;
  });

  it("CONTROL: renders on the device that opened the trade (cache hit)", () => {
    asTradingDevice();
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent).toMatch(/PnL/i);
  });

  it("renders on ANY OTHER device, from the entry back-solved on chain", () => {
    // The regression. Before the fix this returned null and the badge vanished.
    asSecondDevice();
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent).toMatch(/PnL/i);
  });

  it("the back-solve recovers the reporter's actual fill price, not an approximation", () => {
    // Justifies rendering at all: with no cache the resolver returns the exact
    // desktop fill price from the on-chain pnl.
    asSecondDevice();
    const resolved = resolveEntryPrice(POSITION_SIZE, 0n, ON_CHAIN_PNL, ORACLE_E6);
    expect(resolved.source).toBe("derived");
    expect(resolved.entry).toBe(TRUE_ENTRY_E6);
  });

  it("still hides when the entry is genuinely UNRECOVERABLE (pnl = 0, no cache)", () => {
    // source "unknown" carries the MARK as the entry, so rendering would mean a
    // confident $0.00 -- "your position is flat" -- which this badge must never
    // show. The fix must not turn the old bail-out into a fabricated zero.
    asSecondDevice();
    zeroPnl = true;
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent ?? "").toBe("");
  });

  it("a u64::MAX sentinel pnl is not fed to the resolver as a real number", () => {
    // An uninitialised on-chain u64 reads as u64::MAX. Without isSentinelValue
    // that is a vast "pnl"; with it the position reads as unknown and hides.
    asSecondDevice();
    sentinelPnl = true;
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent ?? "").toBe("");
  });

  it("a cache hit still wins over the back-solve (unchanged behaviour)", () => {
    // Guards against the fix accidentally preferring the derived value: with the
    // cache present the source must be "cache", so a position whose pnl is 0 --
    // which would otherwise be "unknown" -- still renders.
    asTradingDevice();
    zeroPnl = true;
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent).toMatch(/PnL/i);
  });
});
