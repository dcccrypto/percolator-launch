/**
 * Council r6 M2: Portfolio and the close dialog showed an entry (83.08) other than the recorded open (83.417) and a profit on a
 * loss. A portfolio row is a snapshot taken before the open-time entry was saved, so it froze a back-solved `derived` entry
 * (from the portfolio-wide on-chain `pnl`, leftover claim included). portfolioPositionPnl now reads the device cache at use,
 * like the trade page's terminalPositionPnl, so both resolve one entry and one PnL.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { portfolioPositionPnl, terminalPositionPnl, type PortfolioPnlSource } from "@/lib/position-pnl";
import { saveEntryPrice } from "@/lib/entry-price";
import { classifyLiquidation } from "@/lib/liquidation-state";

const ADL_ONE = 1_000_000_000_000_000n;
const SLAB = "SLAB1111111111111111111111111111111111111111";
const OWNER = new PublicKey("11111111111111111111111111111111");
const WALLET = OWNER.toBase58();
const SIZE = 239_759n; // 0.239759 SOL
const OPEN = 83_416_991n; // the recorded open
const MARK = 83_350_298n;
// The portfolio-wide pnl carries +0.08 of earlier settled value that is not this position's.
const LEFTOVER_PNL = 64_334n;

const factors = { aLong: ADL_ONE, aShort: ADL_ONE } as never;

function snapshot(basisQ: bigint, pnl: bigint): PortfolioPnlSource {
  return {
    account: { positionSize: basisQ, adlABasis: ADL_ONE, pnl, capital: 10_000_000n } as never,
    adlFactors: factors,
    adlApplicable: true,
    // Polled before the entry was saved: a back-solve of `pnl` at the mark (what the row froze).
    effectiveEntryPrice: basisQ > 0n ? MARK - (pnl * 1_000_000n) / SIZE : MARK + (pnl * 1_000_000n) / SIZE,
    entryPriceSource: "derived",
    initialMarginBps: 1000n,
    maintenanceMarginBps: 500n,
    oraclePriceE6: MARK,
    slabAddress: SLAB,
    idx: 0,
    entryCacheWallet: WALLET,
  };
}

beforeEach(() => localStorage.clear());

describe("portfolio row / close dialog use the recorded entry, as the trade page does", () => {
  const cases: Array<{ name: string; basisQ: bigint; entry: bigint; mark: bigint; sign: 1 | -1 }> = [
    { name: "long, loss", basisQ: SIZE, entry: OPEN, mark: MARK, sign: -1 },
    { name: "long, profit", basisQ: SIZE, entry: 83_000_000n, mark: MARK, sign: 1 },
    { name: "short, loss", basisQ: -SIZE, entry: 83_000_000n, mark: MARK, sign: -1 },
    { name: "short, profit", basisQ: -SIZE, entry: OPEN, mark: MARK, sign: 1 },
  ];
  for (const c of cases) {
    it(`${c.name}: entry is the recorded open and PnL has the chain's sign`, () => {
      saveEntryPrice(SLAB, 0, c.entry, 2, WALLET, c.basisQ);
      const pos = snapshot(c.basisQ, LEFTOVER_PNL);
      const p = portfolioPositionPnl(pos, c.mark);
      expect(p.entrySource).toBe("cache");
      expect(p.entry).toBe(c.entry);
      expect(p.pnlKnown).toBe(true);
      expect(p.unrealizedPnl! * BigInt(c.sign)).toBeGreaterThan(0n);
      // and it is the same figure the trade page's adapter computes for the same account
      const t = terminalPositionPnl({
        account: { positionSize: c.basisQ, adlABasis: ADL_ONE, pnl: LEFTOVER_PNL, capital: 10_000_000n, owner: OWNER },
        slabAddress: SLAB, accountIdx: 0, adlFactors: factors, adlApplicable: true, markE6: c.mark, anchorMarkE6: MARK,
        initialMarginBps: 1000n, maintenanceMarginBps: 500n,
      });
      expect(p.entry).toBe(t.entry);
      expect(p.unrealizedPnl).toBe(t.unrealizedPnl);
    });
  }

  it("a stale 'cache' snapshot follows the current saved entry (e.g. after an add)", () => {
    saveEntryPrice(SLAB, 0, 83_500_000n, 2, WALLET, SIZE);
    const pos = { ...snapshot(SIZE, LEFTOVER_PNL), entryPriceSource: "cache" as const, effectiveEntryPrice: OPEN };
    expect(portfolioPositionPnl(pos, MARK).entry).toBe(83_500_000n);
  });

  it("NEGATIVE CONTROL: with nothing saved the row stays a labelled estimate (and is not the recorded open)", () => {
    const p = portfolioPositionPnl(snapshot(SIZE, LEFTOVER_PNL), MARK);
    expect(p.entrySource).toBe("derived");
    expect(p.isEstimate).toBe(true);
    expect(p.entry).not.toBe(OPEN);
  });
});

describe("no saved entry on this device: never a profit on a loss, on any surface adapter", () => {
  const LONG_LOSS_ONCHAIN_PNL = 1_100_000n; // leftover claimable value on the portfolio, +1.10
  const params = { slabAddress: SLAB, accountIdx: 0, adlFactors: factors, adlApplicable: true, markE6: MARK, anchorMarkE6: MARK, initialMarginBps: 1000n, maintenanceMarginBps: 500n };

  it("long that lost (entry above mark), pnl scalar positive: Portfolio/close dialog show entry unknown and no PnL", () => {
    const p = portfolioPositionPnl({ ...snapshot(SIZE, LONG_LOSS_ONCHAIN_PNL), entryCacheWallet: WALLET }, MARK);
    expect(p.pnlKnown).toBe(false);
    expect(p.unrealizedPnl).toBeNull();
    expect(p.roe).toBeNull();
  });

  it("the dock/badge adapter agrees: no PnL either", () => {
    const t = terminalPositionPnl({ ...params, account: { positionSize: SIZE, adlABasis: ADL_ONE, pnl: LONG_LOSS_ONCHAIN_PNL, capital: 10_000_000n, owner: OWNER } });
    expect(t.pnlKnown).toBe(false);
    expect(t.unrealizedPnl).toBeNull();
  });

  it("short too", () => {
    const p = portfolioPositionPnl(snapshot(-SIZE, LONG_LOSS_ONCHAIN_PNL), MARK);
    expect(p.pnlKnown).toBe(false);
  });

  it("the entry display helper treats a derived entry as unknown", async () => {
    const { describeEntryPrice } = await import("@/lib/entry-price-display");
    const d = describeEntryPrice({ entryE6: 83_081_967n, source: "derived" });
    expect(d.known).toBe(false);
    expect(d.text).toBe("—");
    expect(d.title).toMatch(/Entry unknown on this device/);
  });
});

describe("withholding the entry/PnL does not withhold risk or value", () => {
  const ONCHAIN = 1_100_000n;
  const params = { slabAddress: SLAB, accountIdx: 0, adlFactors: factors, adlApplicable: true, markE6: MARK, anchorMarkE6: MARK, initialMarginBps: 1000n, maintenanceMarginBps: 500n };

  it("riskKnown stays true with a derived entry (liquidation / covered status), pnlKnown is false", () => {
    const p = portfolioPositionPnl(snapshot(SIZE, ONCHAIN), MARK);
    expect(p.pnlKnown).toBe(false);
    expect(p.riskKnown).toBe(true);
    expect(p.liquidationPriceE6).not.toBeNull();
    const t = terminalPositionPnl({ ...params, account: { positionSize: SIZE, adlABasis: ADL_ONE, pnl: ONCHAIN, capital: 10_000_000n, owner: OWNER } });
    expect(t.riskKnown).toBe(true);
    expect(t.liquidationPriceE6).toBe(p.liquidationPriceE6);
  });

  it("riskKnown is false only when nothing resolves (unknown entry) or the ADL state is unknown", () => {
    expect(portfolioPositionPnl(snapshot(SIZE, 0n), MARK).riskKnown).toBe(false);
    expect(portfolioPositionPnl({ ...snapshot(SIZE, ONCHAIN), adlFactors: null }, MARK).riskKnown).toBe(false);
  });

  it("value side keeps the on-chain equity: capital + riskUnrealizedPnl == capital + pnl at the anchor mark", () => {
    const p = portfolioPositionPnl(snapshot(SIZE, ONCHAIN), MARK);
    expect(p.unrealizedPnl).toBeNull();
    // the back-solve is exact up to one e6 tick of integer flooring
    const diff = p.riskUnrealizedPnl! - ONCHAIN;
    expect(diff >= -1n && diff <= 1n).toBe(true);
  });
});

describe("covered / unliquidatable status survives an unknown entry", () => {
  it("a well-collateralised long from another device reads unliquidatable, not unknown", () => {
    const pos = { ...snapshot(SIZE, 1_100_000n), account: { positionSize: SIZE, adlABasis: ADL_ONE, pnl: 1_100_000n, capital: 1_000_000_000_000n } as never };
    const p = portfolioPositionPnl(pos, MARK);
    expect(p.pnlKnown).toBe(false);
    expect(p.liquidationPriceE6).toBe(0n);
    expect(classifyLiquidation(SIZE, MARK, p.liquidationPriceE6!, p.riskKnown).kind).toBe("unliquidatable");
  });
  it("control: with nothing resolvable the status stays unknown", () => {
    const pos = { ...snapshot(SIZE, 0n), account: { positionSize: SIZE, adlABasis: ADL_ONE, pnl: 0n, capital: 1_000_000_000_000n } as never };
    const p = portfolioPositionPnl(pos, MARK);
    expect(classifyLiquidation(SIZE, MARK, p.liquidationPriceE6 ?? 0n, p.riskKnown).kind).toBe("unknown");
  });
});
