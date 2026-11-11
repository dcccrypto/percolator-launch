/**
 * r8 BUG A: on v2.2 the saved entry was the FILL event's BOOKED price (the mark at execution), so the displayed PnL was gross of the spread
 * (a trade that lost net read a small green PnL). The entry is now the price the trader actually paid (booked +/- the spread part of the fee,
 * effectivePriceE6), and every surface values PnL as size x (mark - fill entry). RISK math keeps the engine's basis (the booked price): the
 * spread already left capital as a fee, so liquidation price / equity / value sums must not count it twice.
 *
 * Numbers: a $100 mark, 0.5 SOL, spread part of the fee 0.40 per unit. Long: booked 100, paid 100.40. Short: booked 100, received 99.60.
 */
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import { computePositionPnl, portfolioPositionPnl, terminalPositionPnl, type PortfolioPnlSource } from "@/lib/position-pnl";
import { getSavedEntry, saveEntryPrice } from "@/lib/entry-price";
import { effectivePriceE6, type ExecFill } from "@/lib/v22/exec-fill";
import { computeEngineLiqPrice } from "@/lib/liquidation-risk";

const ADL_ONE = 1_000_000_000_000_000n;
const SLAB = "SLAB1111111111111111111111111111111111111111";
const OWNER = new PublicKey("11111111111111111111111111111111");
const WALLET = OWNER.toBase58();
const SIZE = 500_000n; // 0.5
const BOOKED = 100_000_000n;
const PAID_LONG = 100_400_000n;
const GOT_SHORT = 99_600_000n;
const CAPITAL = 10_000_000n;
const factors = { aLong: ADL_ONE, aShort: ADL_ONE } as never;

beforeEach(() => localStorage.clear());

const pnlOf = (q: bigint, entry: bigint, mark: bigint) => (q * (mark - entry)) / 1_000_000n;

describe("the entry is the price paid (effectivePriceE6), the same price the fill toast shows", () => {
  it("a buy: booked + the spread part of the fee per unit; a sell: booked -", () => {
    const fill = (q: bigint): ExecFill => ({ bookedPriceE6: BOOKED, executedQ: q, feeAtoms: 50_000n + 200_000n, notionalAtoms: 50_000_000n, taker: OWNER, quotedPriceE6: 0n, legs: 1 });
    // base 10 bps on 50 USDC = 50_000; the rest (200_000) over 0.5 = 0.40 a unit
    expect(effectivePriceE6(fill(SIZE), 10n)).toBe(PAID_LONG);
    expect(effectivePriceE6(fill(-SIZE), 10n)).toBe(GOT_SHORT);
    expect(effectivePriceE6(fill(SIZE), null)).toBeNull();
  });
});

describe("a mark between the oracle at fill and the fill price, on the losing side, is a LOSS everywhere", () => {
  const cases = [
    // long paid 100.40, mark 100.20: above the booked 100 (gross-of-spread PnL would be GREEN) but below what was paid
    { name: "long", q: SIZE, paid: PAID_LONG, mark: 100_200_000n },
    // short received 99.60, mark 99.80: below the booked 100 (gross would be GREEN) but above what was received
    { name: "short", q: -SIZE, paid: GOT_SHORT, mark: 99_800_000n },
  ];
  for (const c of cases) {
    describe(c.name, () => {
      const save = () => saveEntryPrice(SLAB, 0, c.paid, 3, WALLET, c.q, { bookedPriceE6: BOOKED });
      const account = { positionSize: c.q, adlABasis: ADL_ONE, pnl: 0n, capital: CAPITAL, owner: OWNER };
      const snapshot = (): PortfolioPnlSource => ({
        account: account as never,
        adlFactors: factors,
        adlApplicable: true,
        effectiveEntryPrice: c.paid,
        entryPriceSource: "cache",
        initialMarginBps: 1000n,
        maintenanceMarginBps: 500n,
        oraclePriceE6: c.mark,
        slabAddress: SLAB,
        idx: 0,
        entryCacheWallet: WALLET,
      });

      it("the booked-price PnL would have been a gain (the bug), the fill-price PnL is a loss", () => {
        expect(pnlOf(c.q, BOOKED, c.mark) > 0n).toBe(true);
        expect(pnlOf(c.q, c.paid, c.mark) < 0n).toBe(true);
      });

      it("Portfolio / bar / dashboard (portfolioPositionPnl): entry = fill, PnL negative", () => {
        save();
        const p = portfolioPositionPnl(snapshot(), c.mark);
        expect(p.entry).toBe(c.paid);
        expect(p.pnlKnown).toBe(true);
        expect(p.unrealizedPnl! < 0n).toBe(true);
        expect(p.unrealizedPnl).toBe(pnlOf(c.q, c.paid, c.mark));
      });

      it("trade page (dock, position panel, chart badge: terminalPositionPnl) gives the same figure", () => {
        save();
        const t = terminalPositionPnl({
          account: account as never,
          slabAddress: SLAB,
          accountIdx: 0,
          adlFactors: factors,
          adlApplicable: true,
          markE6: c.mark,
          initialMarginBps: 1000n,
          maintenanceMarginBps: 500n,
        });
        const p = portfolioPositionPnl(snapshot(), c.mark);
        expect(t.entry).toBe(p.entry);
        expect(t.unrealizedPnl).toBe(p.unrealizedPnl);
        expect(t.unrealizedPnl! < 0n).toBe(true);
      });

      it("the close dialogs and the ticket's Close tab (ClosePositionForm) show a negative Est. PnL from that entry", () => {
        save();
        const p = portfolioPositionPnl(snapshot(), c.mark);
        const { container } = render(
          <ClosePositionForm
            variant="modal"
            positionSize={p.effectiveSize!}
            entryPrice={p.entry}
            riskEntryPrice={p.riskEntry}
            currentPrice={c.mark}
            capital={CAPITAL}
            symbol="SOL"
            decimals={6}
            priceUsd={Number(c.mark) / 1e6}
            isLong={c.q > 0n}
            loading={false}
            onConfirm={() => {}}
            onCancel={() => {}}
          />,
        );
        const t = container.textContent ?? "";
        const i = t.indexOf("Est. PnL");
        expect(i).toBeGreaterThan(-1);
        expect(t.slice(i, i + 40)).toMatch(/-0\.\d+/);
      });

      it("RISK math keeps the engine's basis: riskEntry = booked, and the value sums use it (the spread is not counted twice)", () => {
        save();
        const p = portfolioPositionPnl(snapshot(), c.mark);
        expect(p.riskEntry).toBe(BOOKED);
        expect(p.riskUnrealizedPnl).toBe(pnlOf(c.q, BOOKED, c.mark));
        expect(p.riskUnrealizedPnl! > p.unrealizedPnl!).toBe(true);
        expect(p.liquidationPriceE6).toBe(computeEngineLiqPrice(BOOKED, CAPITAL, p.effectiveSize!, 500n));
        // and the display entry differs from the risk basis by exactly the spread
        expect(p.entry === p.riskEntry).toBe(false);
      });
    });
  }
});

describe("record shape", () => {
  it("the booked price is stored beside the fill entry and read back; absent = the entry is the basis", () => {
    saveEntryPrice(SLAB, 0, PAID_LONG, 2, WALLET, SIZE, { bookedPriceE6: BOOKED });
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ entryPriceE6: PAID_LONG, bookedPriceE6: BOOKED, sizeQ: SIZE });
    saveEntryPrice(SLAB, 1, 83_000_000n, 2, WALLET, SIZE);
    expect(getSavedEntry(SLAB, 1, WALLET)!.bookedPriceE6).toBe(83_000_000n);
  });
  it("an unread fill keeps an UNKNOWN entry, never the mark: no cache means source unknown and no PnL", () => {
    const p = computePositionPnl({
      basisQ: SIZE, aBasis: ADL_ONE, adlFactors: factors, markE6: 100_200_000n, onChainPnl: 0n, initialMarginBps: 1000n, capital: CAPITAL,
    });
    expect(p.entrySource).toBe("unknown");
    expect(p.pnlKnown).toBe(false);
    expect(p.unrealizedPnl).toBeNull();
  });
  it("a position with no booked price (pre-v2.2) is unchanged: risk entry = entry", () => {
    const p = computePositionPnl({
      basisQ: SIZE, aBasis: ADL_ONE, adlFactors: factors, markE6: 101_000_000n, onChainPnl: 0n, initialMarginBps: 1000n, capital: CAPITAL,
      cachedEntryE6: BOOKED, cachedEntryCheck: { sizeQ: SIZE, pending: false },
    });
    expect(p.riskEntry).toBe(p.entry);
    expect(p.riskUnrealizedPnl).toBe(p.unrealizedPnl);
  });
});
