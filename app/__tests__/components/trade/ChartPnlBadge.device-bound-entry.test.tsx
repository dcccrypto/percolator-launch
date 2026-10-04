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
 * Fixture is the reported eacc short at the reporter's prices (entry $0.013432
 * per the desktop fill receipt, mark $0.01333), sized at 10,000 eacc so the
 * PnL is a visible +$1.02: an on-chain pnl that back-solves to EXACTLY that
 * entry. Every rendering test asserts the dollar figure, not just that a badge
 * appeared — a badge that renders the wrong number is worse than none.
 *
 * ADL: the on-chain pnl of a deleveraged leg is earned on its EFFECTIVE size
 * (`basis * a_side / a_basis`; engine v16.rs@35ddd692 accrues K per side scaled
 * by the live `a` and realizes `basis * dK / a_basis`). The back-solve must
 * divide by that size, or the badge shows `pnl * a_side / a_basis`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { resolveEntryPrice } from "@/lib/trading";
import { saveEntryPrice } from "@/lib/entry-price";

const SLAB = "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh";
const OWNER = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const IDX = 0;

const POSITION_SIZE = -10_000_000_000n; // short 10,000 eacc (6 dp)
const ORACLE_E6 = 13_330n; // mark  $0.01333
const TRUE_ENTRY_E6 = 13_432n; // entry $0.013432, per the desktop fill receipt
/** on-chain collateral pnl (atoms, 6 dp) = 10,000 x $0.000102 = $1.02, which
 *  back-solves to TRUE_ENTRY_E6 exactly. */
const ON_CHAIN_PNL = 1_020_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const ADL_ONE = 1_000_000_000_000_000n;

let zeroPnl = false;
let sentinelPnl = false;
/** Leg state for the ADL cases: raw basis + the side factor frozen at open. */
let positionSize = POSITION_SIZE;
let adlABasis = 0n;
let adlFactors: { aLong: bigint; aShort: bigint } | null = null;
let onChainPnl = ON_CHAIN_PNL;

const account = {
  owner: OWNER,
  get positionSize() {
    return positionSize;
  },
  get adlABasis() {
    return adlABasis;
  },
  capital: 20_000_000n,
  entryPrice: 0n,
  get pnl() {
    return sentinelPnl ? U64_MAX : zeroPnl ? 0n : onChainPnl;
  },
};

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => ({ idx: IDX, account }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: SLAB,
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    config: { collateralMint: null },
    adlFactors,
  }),
}));
vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: () => ({ priceE6: ORACLE_E6, priceUsd: 0.01333 }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));

const { ChartPnlBadge } = await import("@/components/trade/ChartPnlBadge");
const { effectiveLeg } = await import("@/lib/limits/effective-quantity");

/** The badge's dollar figure, e.g. "+$1.02". */
function badgeUsd(container: HTMLElement): string | null {
  return container.textContent?.match(/[+-]?\$\d+\.\d{2}/)?.[0] ?? null;
}

/** Halve the short side after this leg opened: raw basis -20,000 eacc now
 *  carries 10,000 eacc of exposure, and the engine credited the +$1.02 move on
 *  those 10,000 — the same on-chain pnl as the un-deleveraged fixture. */
function asDeleveragedShort() {
  positionSize = 2n * POSITION_SIZE;
  adlABasis = ADL_ONE;
  adlFactors = { aLong: ADL_ONE, aShort: ADL_ONE / 2n };
}

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
    positionSize = POSITION_SIZE;
    adlABasis = 0n;
    adlFactors = null;
    onChainPnl = ON_CHAIN_PNL;
  });

  it("CONTROL: renders on the device that opened the trade (cache hit) at the cached-entry PnL", () => {
    asTradingDevice();
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent).toMatch(/PnL/i);
    // 10,000 short from $0.013432 to $0.01333 = +$1.02.
    expect(badgeUsd(container)).toBe("+$1.02");
  });

  it("renders on ANY OTHER device, from the entry back-solved on chain, at the SAME PnL", () => {
    // The regression. Before the fix this returned null and the badge vanished.
    // The number must match the trading device's, not merely appear.
    asSecondDevice();
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(container.textContent).toMatch(/PnL/i);
    expect(badgeUsd(container)).toBe("+$1.02");
  });

  it("a losing derived position reads as a loss of the on-chain amount", () => {
    asSecondDevice();
    onChainPnl = -ON_CHAIN_PNL;
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(badgeUsd(container)).toBe("-$1.02");
  });

  it("ADL: a deleveraged leg on a second device shows its on-chain pnl, not pnl x a_side/a_basis", () => {
    // Fixture sanity: the app's effective size equals the engine port
    // (effective_abs_quantity_for_leg, engine 35ddd692 v16.rs:1695) for this leg.
    asDeleveragedShort();
    const eff = effectiveLeg(
      { aLong: ADL_ONE, aShort: ADL_ONE / 2n, epochLong: 0n, epochShort: 0n, modeLong: 0, modeShort: 0 },
      { active: true, side: 1, basisPosQ: positionSize, aBasis: adlABasis, epochSnap: 0n },
    );
    expect(eff).toEqual({ kind: "live", absQ: -POSITION_SIZE, signedQ: POSITION_SIZE });

    asSecondDevice();
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    // On-chain pnl is +$1.02, earned on the 10,000 effective. Back-solving over
    // the 20,000 raw basis put the entry at $0.013381 and showed +$0.51.
    expect(badgeUsd(container)).toBe("+$1.02");
  });

  it("CONTROL (ADL): the same deleveraged leg with its cached entry also shows +$1.02", () => {
    // Cache path is untouched by the fix: effective 10,000 x $0.000102.
    asDeleveragedShort();
    asTradingDevice();
    const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(badgeUsd(container)).toBe("+$1.02");
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
