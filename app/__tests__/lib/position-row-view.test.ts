/**
 * #2560: computePositionRowView is the pure per-row derivation behind the multi-portfolio positions
 * table (each portfolio row). The first PR's description said it was unit-tested; it was not. It
 * is a faithful move of PositionsDock's PositionRow derivation, so it is pinned two ways:
 *  1. against the primitives it composes (terminalPositionPnl / describeLiqPrice /
 *     computePositionLeverage), for a long and a short;
 *  2. PARITY with the single-row dock (PositionsDock.position-row-parity.test.tsx), which renders the
 *     real row and compares it to this function;
 * plus the entry SCOPING contract: only the primary may read the legacy (unscoped) entry; an
 * isolated row reads its OWN scoped entry or shows "unknown", never the cross account's.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Account } from "@percolatorct/sdk";
import { computePositionRowView, type PositionRowViewDeps } from "@/lib/position-row-view";
import { terminalPositionPnl } from "@/lib/position-pnl";
import { describeLiqPrice } from "@/lib/liq-price-display";
import { computePositionLeverage, describePositionLeverage } from "@/lib/position-leverage";
import { saveEntryPrice } from "@/lib/entry-price";

const ADL_ONE = 1_000_000_000_000_000n;
const WALLET = new PublicKey(new Uint8Array(32).fill(0x42));
const CROSS = new PublicKey(new Uint8Array(32).fill(0x11)).toBase58();
const ISO = new PublicKey(new Uint8Array(32).fill(0x22)).toBase58();
const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";

const account = (over: Partial<Record<string, unknown>> = {}): Account =>
  ({
    kind: 0, owner: WALLET, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n,
    entryPrice: 0n, adlABasis: ADL_ONE, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  }) as unknown as Account;

const deps = (over: Partial<PositionRowViewDeps> = {}): PositionRowViewDeps => ({
  account: account(),
  accountIdx: 0,
  slabAddress: SLAB,
  portfolio: CROSS,
  isPrimary: true,
  config: { lastEffectivePriceE6: 100_000_000n, invert: 0 },
  adlApplicable: true,
  adlFactors: { aLong: ADL_ONE, aShort: ADL_ONE },
  livePriceE6: 100_000_000n,
  maintenanceMarginBps: 500n,
  initialMarginBps: 1000n,
  engineVault: null,
  insuranceBalance: 0n,
  decimals: 6,
  marketInfo: null,
  marketDisplaySymbol: "SOL",
  ...over,
});

beforeEach(() => localStorage.clear());

describe("computePositionRowView: composes the shared primitives", () => {
  it("LONG with a known (cached) entry: size, entry, pnl, roe, leverage and liq match the primitives", () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 5, WALLET.toBase58(), CROSS);
    const d = deps({ livePriceE6: 100_000_000n });
    const v = computePositionRowView(d);

    const p = terminalPositionPnl({
      account: d.account, slabAddress: SLAB, accountIdx: 0, adlFactors: d.adlFactors, adlApplicable: true,
      markE6: 100_000_000n, anchorMarkE6: 100_000_000n, initialMarginBps: 1000n, maintenanceMarginBps: 500n, portfolio: CROSS,
    });
    expect(v.isLong).toBe(true);
    expect(v.entryPriceE6).toBe(90_000_000n);
    expect(v.entryKnown).toBe(true);
    expect(v.pnlIsKnown).toBe(p.pnlKnown);
    expect(v.pnlTokens).toBe(p.unrealizedPnl ?? 0n);
    expect(v.roe).toBe(p.roe ?? 0);
    expect(v.effectiveSize).toBe(p.effectiveSize ?? 40_000_000n);
    expect(v.pnlTokens).toBeGreaterThan(0n); // long, mark above entry
    expect(v.pnlColor).toContain("--long");
    expect(v.leverage).toEqual(
      describePositionLeverage(computePositionLeverage({ sizeQ: 40_000_000n, markPriceE6: 100_000_000n, capital: 1_000_000_000n, pnl: 0n, collateralDecimals: 6 })),
    );
    expect(v.liqDisplay).toEqual(
      describeLiqPrice({
        liqPriceE6: p.liquidationPriceE6 ?? 0n, positionSize: 40_000_000n, capital: 1_000_000_000n,
        markPriceE6: 100_000_000n, maintenanceMarginBps: 500n, hasResolvedEntry: p.pnlKnown,
      }),
    );
    expect(v.pnlCardData?.entryE6).toBe(90_000_000n); // shareable only with an exact entry
  });

  it("SHORT: flips the side flags and the pnl sign for a mark above entry", () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 5, WALLET.toBase58(), CROSS);
    const v = computePositionRowView(deps({ account: account({ positionSize: -40_000_000n }) }));
    expect(v.isLong).toBe(false);
    expect(v.absPosition).toBe(40_000_000n);
    expect(v.pnlTokens).toBeLessThan(0n);
    expect(v.pnlColor).toContain("--short");
  });

  it("no valid mark: pnl/usd are withheld and hasValidMark is false", () => {
    const v = computePositionRowView(deps({ livePriceE6: null, config: null }));
    expect(v.hasValidMark).toBe(false);
    expect(v.pnlUsd).toBeNull();
    expect(v.pnlCardData).toBeNull();
  });

  it("an ADL-deleveraged leg reports the reduction and its effective size", () => {
    const v = computePositionRowView(deps({ adlFactors: { aLong: ADL_ONE / 2n, aShort: ADL_ONE } }));
    expect(v.wasDeleveraged).toBe(true);
    expect(v.adlRemaining).toBe(5000);
    expect(v.absNominal).toBe(40_000_000n);
  });
});

describe("computePositionRowView: entry scoping (isPrimary gates the legacy fallback)", () => {
  const legacy = () => saveEntryPrice(SLAB, 0, 90_000_000n, 5, WALLET.toBase58()); // portfolio-less (cross) key

  it("PRIMARY with only a legacy entry: resolves it (the cross account's entry)", () => {
    legacy();
    const v = computePositionRowView(deps({ portfolio: CROSS, isPrimary: true }));
    expect(v.entryKnown).toBe(true);
    expect(v.entryPriceE6).toBe(90_000_000n);
  });

  it("ISOLATED (isPrimary=false) with only a legacy entry: unknown, never the cross entry", () => {
    legacy();
    const v = computePositionRowView(deps({ portfolio: ISO, isPrimary: false }));
    expect(v.entryKnown).toBe(false);
    expect(v.pnlIsKnown).toBe(false);
    expect(v.pnlCardData).toBeNull();
  });

  it("ISOLATED reads its OWN scoped entry, and the cross row does not see it", () => {
    legacy();
    saveEntryPrice(SLAB, 0, 95_000_000n, 5, WALLET.toBase58(), ISO);
    const iso = computePositionRowView(deps({ portfolio: ISO, isPrimary: false }));
    expect(iso.entryKnown).toBe(true);
    expect(iso.entryPriceE6).toBe(95_000_000n);
    const cross = computePositionRowView(deps({ portfolio: CROSS, isPrimary: true }));
    expect(cross.entryPriceE6).toBe(90_000_000n); // legacy, not the isolated scoped one
  });
});
