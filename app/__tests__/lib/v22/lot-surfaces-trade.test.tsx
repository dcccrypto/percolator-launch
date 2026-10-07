/**
 * F3 (security review of #3235): on a v2.2 LOT market every mark / entry / liquidation price and every position q is
 * PER LOT, while users think in TOKENS. Each trade-side surface converts through lib/v22/lot.ts; each test below fails if
 * that conversion is dropped. lotExp 0 is the control: the same inputs are unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useLockBodyScroll", () => ({ useLockBodyScroll: () => {} }));
vi.mock("gsap", () => ({ default: { set: () => {}, to: () => {}, fromTo: () => {}, killTweensOf: () => {} } }));

import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import { sizeQToInput } from "@/lib/limits/ticket";
import { maxInUnit } from "@/lib/limits/ticket-state";
import { fmtQ } from "@/components/limits/OrderTicketLimits";
import { POS_SCALE_V22, formatLotPriceE6, formatLotQ, quantizeQToLots, tokenUsdOfLotUsd } from "@/lib/v22/lot";

const K = 3; // 1 lot = 1,000 tokens
const LOT = POS_SCALE_V22;

/** The ticket's own derivation: typed tokens -> notional (per-TOKEN price) -> Q from the per-LOT mark -> whole lots. */
function ticketQ(typedTokens: number, perLotUsd: number, lotExp: number): { q: bigint; remainderTokens: number } {
  const typedPrice = tokenUsdOfLotUsd(perLotUsd, lotExp);
  const notionalNative = BigInt(Math.floor(typedTokens * typedPrice * 1e6)); // 6-decimal collateral atoms, truncated like the ticket
  const perLotE6 = BigInt(Math.round(perLotUsd * 1e6));
  const raw = (notionalNative * 1_000_000n) / perLotE6;
  const { q, remainderQ } = quantizeQToLots(raw, lotExp);
  return { q, remainderTokens: Number(remainderQ) / 1e6 * 10 ** lotExp };
}

describe("order entry: typed tokens become LOTS", () => {
  it("1,000 tokens on a lotExp 3 market is q = 1 lot (1,000,000 Q), not 1,000 lots", () => {
    expect(ticketQ(1000, 12, K).q).toBe(LOT);
    expect(ticketQ(1000, 12, K).q).not.toBe(1000n * LOT);
  });
  it("1,500 tokens is 1 lot and shows a 500-token remainder that is NOT sent", () => {
    const r = ticketQ(1500, 12, K);
    expect(r.q).toBe(LOT);
    expect(r.remainderTokens).toBeCloseTo(500, 3);
  });
  it("CONTROL lotExp 0: the typed size is the Q, nothing is quantised", () => {
    expect(ticketQ(1.5, 12, 0).q).toBe(1_500_000n);
    expect(quantizeQToLots(1_500_000n, 0)).toEqual({ q: 1_500_000n, remainderQ: 0n });
  });
  it("an exact lot never collapses to 0 lots through margin-atom truncation", () => {
    expect(quantizeQToLots(999_999n, K).q).toBe(LOT);
    expect(quantizeQToLots(999_990n, K).q).toBe(0n);
  });
});

describe("size box and max (lib/limits/ticket, ticket-state)", () => {
  it("sizeQToInput shows TOKENS for a Q in lots", () => {
    expect(sizeQToInput(2n * LOT, "token", 12_000_000n, K)).toBe("2000");
    expect(sizeQToInput(2n * LOT, "token", 12_000_000n)).toBe("2"); // control
  });
  it("maxInUnit and the limits row show tokens", () => {
    expect(maxInUnit(2n * LOT, "token", 12_000_000n, "TOK", K)).toBe("2,000 TOK");
    expect(maxInUnit(2n * LOT, "token", 12_000_000n, "TOK")).toBe("2 TOK");
    expect(fmtQ(2n * LOT, K)).toBe(fmtQ(2_000n * LOT));
    expect(fmtQ(2n * LOT)).toBe(fmtQ(2n * LOT, 0));
  });
});

describe("display helpers", () => {
  it("a per-lot price shows per token; a size in lots shows in tokens", () => {
    expect(formatLotPriceE6(12_000_000n, K)).toBe("$0.012");
    expect(formatLotPriceE6(12_000_000n, 0)).toBe("$12.000000");
    expect(formatLotQ(3n * LOT, 6, K)).toBe("3000");
    expect(formatLotQ(3n * LOT, 6, 0)).toBe("3");
  });
});

describe("confirmation modal", () => {
  const props = (lotExp: number) => ({
    direction: "long" as const,
    positionSize: 2n * LOT,
    lotExp,
    margin: 100_000_000n,
    leverage: 2,
    estimatedLiqPrice: 6_000_000n,
    tradingFee: 50_000n,
    worstFillPriceE6: 12_100_000n,
    accountEquity: 500_000_000n,
    symbol: "TOK",
    collateralSymbol: "USDC",
    decimals: 6,
    onConfirm: () => {},
    onCancel: () => {},
  });
  it("shows the size in tokens and the max/min fill price per token on a lot market", () => {
    render(<TradeConfirmationModal {...props(K)} />);
    expect(screen.getByText(/2000 TOK/)).toBeInTheDocument();
    expect(screen.getByText("$0.0121")).toBeInTheDocument();
  });
  it("CONTROL lotExp 0", () => {
    render(<TradeConfirmationModal {...props(0)} />);
    expect(screen.getByText(/2 TOK/)).toBeInTheDocument();
    expect(screen.getByText("$12.1")).toBeInTheDocument();
  });
});

describe("close form (and the close modal / ticket close panel that mount it)", () => {
  const form = (lotExp: number) => (
    <ClosePositionForm
      variant="inline"
      positionSize={2n * LOT}
      lotExp={lotExp}
      entryPrice={12_000_000n}
      currentPrice={13_000_000n}
      capital={500_000_000n}
      symbol="TOK"
      collateralSymbol="USDC"
      decimals={6}
      priceUsd={13}
      isLong
      loading={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
  it("shows the position in tokens and the entry per token", () => {
    const { container } = render(form(K));
    expect(container.textContent).toContain("Long Position2000 TOK at $0.012 entry");
    expect(container.textContent).toContain("Close Size:2000 TOK");
  });
  it("CONTROL lotExp 0", () => {
    const { container } = render(form(0));
    expect(container.textContent).toContain("Long Position2 TOK at $12.000000 entry");
  });
});

/**
 * Surfaces too heavy to render in jsdom (they need the slab/price/wallet providers): a source guard that each
 * routes its size / price display through lib/v22/lot.ts. Dropping the conversion removes the pattern and fails.
 */
const src = (p: string): string => readFileSync(join(__dirname, "../../..", p), "utf8");
const GUARDS: Array<[string, string, RegExp[]]> = [
  ["order ticket: typed size converts at the per-token price, Q is quantised to whole lots, remainder shown, sign guard", "components/trade/OrderTicket.tsx", [/lotExpOf\(slabRaw\)/, /tokenUsdOfLotUsd\(priceUsd, lotExp\)/, /quantizeQToLots\(/, /lot-remainder/, /% POS_SCALE_V22 !== 0n/, /sizeQToInput\(q, sizeUnit, livePriceE6, lotExp\)/, /maxInUnit\(displayMaxQ!, sizeUnit, livePriceE6!, baseTicker, lotExp\)/, /formatLotPriceE6\(e6, lotExp\)/]],
  ["order ticket limits row: sizes and mark/band/quote prices", "components/limits/OrderTicketLimits.tsx", [/fmtQ\(lim\.maxQ, lotExp\)/, /formatLotPriceE6\(mark, lotExp\)/, /formatLotPriceE6\(q\.quotePriceE6, lotExp\)/]],
  ["positions dock: size, entry, mark, liquidation price, share card", "components/trade/PositionsDock.tsx", [/lotExpOf\(slabRawForLot\)/, /formatLotQ\(absPosition, decimals, lotExp\)/, /formatLotPriceE6\(entryPriceE6, lotExp\)/, /formatLotPriceE6\(currentPriceE6, lotExp\)/, /formatPrice: \(e6: bigint\) => formatLotPriceE6\(e6, lotExp\)/, /\n\s+lotExp,\n\s+}/]],
  ["position panel: size, entry, mark", "components/trade/PositionPanel.tsx", [/formatLotQ\(absPosition, decimals, lotExp\)/, /formatLotPriceE6\(entryPriceE6, lotExp\)/, /formatLotPriceE6\(currentPriceE6, lotExp\)/]],
  ["accounts card: size, entry, liquidation price", "components/trade/AccountsCard.tsx", [/formatLotQ\(absPos, decimals, lotExp\)/, /formatLotPriceE6\(row\.entryPrice, lotExp\)/, /formatLotPriceE6\(e6, lotExp\)/]],
  ["market info bar: mark price per token", "components/trade/MarketInfoBar.tsx", [/tokenUsdOfLotUsd\(priceUsd, lotExp\)/]],
  ["position limits row: liquidation drift price", "components/limits/PositionLimitsRow.tsx", [/formatLotPriceE6\(drift\.liqMoveE6, lotExp\)/]],
  ["close panel and modal pass the exponent down", "components/trade/OrderTicketClosePanel.tsx", [/lotExp=\{lotExp\}/]],
  ["close modal", "components/trade/ClosePositionModal.tsx", [/lotExp=\{lotExp\}/]],
];
describe("source guards (surfaces that need providers to render)", () => {
  it.each(GUARDS)("%s", (_n, file, pats) => {
    const s = src(file);
    for (const p of pats) expect(s, `${file} must match ${p}`).toMatch(p);
  });
});
