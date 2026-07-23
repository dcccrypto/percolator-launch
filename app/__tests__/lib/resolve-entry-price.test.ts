import { describe, it, expect } from "vitest";
import {
  resolveEntryPrice,
  estimateEntryFromPnl,
  computeMarkPnlCollateral,
} from "@/lib/trading";
import { computeMarkPnl } from "@percolatorct/sdk";

/**
 * Regression cover for the "losing position displays as flat" PnL bug.
 *
 * ON-CHAIN GROUND TRUTH (percolator/src/v16.rs, read-only):
 *   `reserve_new_capital_backed_loss_for_source_domain_not_atomic` (9382-9437)
 *   moves a realized loss OUT of `capital` and adds the same amount BACK to
 *   `pnl`, driving `pnl` toward 0, and records it in
 *   `residual_crystallized_loss_atoms_total` (8836-8852). Settlement then does
 *   `leg.k_snap = k_now` (9657). So a SOLVENT losing account ends a settle
 *   crank with `pnl == 0` and less capital: total equity is right, the
 *   attribution is gone.
 *
 * Consequence: any client that infers PnL from `portfolio.pnl` reports a
 * losing position as perfectly flat while the trader's capital drains.
 */
describe("resolveEntryPrice — crystallized-loss PnL misreport", () => {
  const ORACLE = 81_170_000n; // $81.17 e6, a real playground SOL mark

  it("uses the cached entry when one was saved at open time", () => {
    const cached = 100_000_000n;
    const r = resolveEntryPrice(200_000n, cached, 0n, ORACLE);
    expect(r.source).toBe("cache");
    expect(r.entry).toBe(cached);
  });

  it("still derives an entry when the on-chain pnl carries real information", () => {
    const r = resolveEntryPrice(200_000n, 0n, -25_890_041n, ORACLE);
    expect(r.source).toBe("derived");
    // Self-consistent: feeding the derived entry back through the app's own
    // mark-PnL formula reproduces the on-chain figure it was backed out of.
    expect(r.entry).toBe(estimateEntryFromPnl(200_000n, -25_890_041n, ORACLE));
  });

  it("REFUSES to invent an entry for an open position whose pnl is 0", () => {
    // Live devnet portfolio 4Fg5efmt on wrapper 69VUZ7a2...: an OPEN 200_000
    // long with pnl == 0, capital 20_109_960, and 29_800_040 atoms of
    // residual_crystallized_loss — i.e. it has already lost MORE than the
    // capital it has left, yet its on-chain pnl reads exactly zero.
    const r = resolveEntryPrice(200_000n, 0n, 0n, ORACLE);
    expect(r.source).toBe("unknown");
  });

  it("demonstrates the pre-fix behaviour it replaces: a fabricated $0.00", () => {
    // What the old code did: estimateEntryFromPnl(size, pnl=0, mark) => mark.
    const oldEntry = estimateEntryFromPnl(200_000n, 0n, ORACLE);
    expect(oldEntry).toBe(ORACLE); // entry == mark

    // ...which then renders as an exactly-flat, confident PnL.
    const fabricatedPnl = computeMarkPnlCollateral(
      computeMarkPnl(200_000n, oldEntry, ORACLE),
      ORACLE,
    );
    expect(fabricatedPnl).toBe(0n);

    // The fix routes this case to "unknown" so the UI prints "--" instead of
    // that 0. Guard the regression: the resolver must not report a source
    // that any display site treats as showable.
    expect(resolveEntryPrice(200_000n, 0n, 0n, ORACLE).source).toBe("unknown");
  });

  it("treats a genuinely flat (closed) position as unknown, not as a PnL claim", () => {
    expect(resolveEntryPrice(0n, 0n, 0n, ORACLE).source).toBe("unknown");
  });

  it("keeps a non-zero numeric entry even when unknown, so risk math is unchanged", () => {
    // Liq-price / locked-margin call sites read `.entry` unconditionally; it
    // must stay a usable denominator (the mark), exactly as before the fix.
    const r = resolveEntryPrice(200_000n, 0n, 0n, ORACLE);
    expect(r.entry).toBe(ORACLE);
    expect(r.entry).toBeGreaterThan(0n);
  });

  it("does not fabricate an entry when the mark is unavailable", () => {
    const r = resolveEntryPrice(200_000n, 0n, -1000n, 0n);
    expect(r.source).toBe("unknown");
  });
});
