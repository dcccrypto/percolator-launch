import { describe, expect, it } from "vitest";
import { computePositionLeverage } from "@/lib/position-leverage";
import { computeMarginHealthPct } from "@/lib/margin-health";

/**
 * Differential: computePositionLeverage vs the engine notional.
 *
 * Engine reference (percolator feat/v22-engine-rc23-2026-10-22, src/v16.rs:28982-28990):
 *   fn trade_notional_floor(size_q, exec_price) { size_q * exec_price / POS_SCALE }
 * The result is in collateral atoms with NO decimals factor (price_e6 already
 * expresses collateral atoms per Q unit), as in margin-health.ts and the SDK.
 */
const POS_SCALE = 1_000_000n;
const engineNotional = (q: bigint, price: bigint) => (q < 0n ? -q : q) * price / POS_SCALE;

// deterministic LCG
let seed = 123456789n;
const rnd = (n: bigint) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return (seed >> 11n) % n;
};

interface Row { dec: number; sizeQ: bigint; mark: bigint; capital: bigint; pnl: bigint }
const rows: Row[] = [];
const sizes = [1n, 1_000n, 1_000_000n, 40_000_000n, 10n ** 12n, 10n ** 15n, 10n ** 18n];
for (const dec of [0, 6, 8, 9]) {
  for (const sign of [1n, -1n]) {
    for (const pnlSign of [1n, -1n, 0n]) {
      for (let i = 0; i < 90; i++) {
        const sizeQ = sign * (i < 14 ? sizes[i % sizes.length] * BigInt(1 + (i >> 3)) : 1n + rnd(10n ** 15n));
        const mark = 1n + rnd(10n ** 10n);
        const capital = 10n ** BigInt(dec) + rnd(10n ** BigInt(dec + 6));
        const pnl = pnlSign * rnd(capital / 2n + 1n);
        rows.push({ dec, sizeQ, mark, capital, pnl });
      }
    }
  }
}
// spec example: decimals 9, 1 base @ $100 on 100e6 atoms -> 1x
rows.push({ dec: 9, sizeQ: 1_000_000n, mark: 100_000_000n, capital: 100_000_000n, pnl: 0n });

describe("computePositionLeverage differential vs engine notional", () => {
  it("has >= 2000 rows", () => expect(rows.length).toBeGreaterThanOrEqual(2000));

  it("spec row: decimals 9 reads 1x, not 1000x", () => {
    const r = computePositionLeverage({ sizeQ: 1_000_000n, markPriceE6: 100_000_000n, capital: 100_000_000n, pnl: 0n, collateralDecimals: 9 });
    expect(r.kind === "ok" && r.leverage).toBe(1);
  });

  it("matches engine notional/equity and margin-health on every row", () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      const equity = row.capital + row.pnl;
      const r = computePositionLeverage({ sizeQ: row.sizeQ, markPriceE6: row.mark, capital: row.capital, pnl: row.pnl, collateralDecimals: row.dec });
      if (equity <= 0n) {
        if (r.kind !== "no-equity") mismatches.push(JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
        continue;
      }
      const n = engineNotional(row.sizeQ, row.mark);
      const expected = Number((n * 10_000n) / equity) / 10_000;
      const ok = r.kind === "ok" && r.leverage === expected && r.notionalAtoms === n;
      // margin health (equity/notional %, floored to 0.1) must bracket the same ratio
      const h = computeMarginHealthPct(row.capital, row.sizeQ, row.mark, row.pnl);
      // health is floored to 0.1%: it must bracket 100/leverage within one step
      // exact (unfloored-notional) equity/notional, %
      const absQ = row.sizeQ < 0n ? -row.sizeQ : row.sizeQ;
      const exact = Number((equity * 100n * POS_SCALE * 1_000_000_000n) / (absQ * row.mark)) / 1_000_000_000;
      const hOk = h == null || exact == null || (h <= exact + 1e-6 && h >= exact - 0.1 - 1e-6);
      if (!ok || !hOk) mismatches.push(JSON.stringify({ ...row, got: r.kind === "ok" ? r.leverage : r.kind, expected, health: h }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    expect(mismatches.length, `${mismatches.length}/${rows.length} mismatches, first: ${mismatches[0]}`).toBe(0);
  });
});
