/**
 * The first trade on a market creates the trader's portfolio account and pays its rent from the
 * wallet (~0.049 SOL at 9,563 bytes; live getMinimumBalanceForRentExemption(9563) = 49,230,280 on
 * devnet and mainnet). The ticket said only "(one approval)" and the confirm modal showed no SOL.
 * The pre-sign shortfall message is covered in first-trade-rent-presign.test.ts (node env).
 */
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { FIRST_TRADE_COPY, FIRST_TRADE_RENT_SOL } from "@/lib/first-trade";
import { portfolioAccountLen } from "@/lib/v22/layout";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";

const RENT = 49_230_280; // live, for V17_PORTFOLIO_ACCOUNT_LEN = 9563
const RENT_V22 = 54_513_480; // (10,603 + 128) x 5,080: the v2.2 portfolio

describe("first trade: the account rent is shown", () => {
  afterEach(cleanup);

  it("the rent figure matches the live rent for the SDK's portfolio size", () => {
    expect(V17_PORTFOLIO_ACCOUNT_LEN).toBe(9563);
    // The figure follows the build's portfolio size (lib/v22/layout portfolioAccountLen): 9,563 B, or 10,603 B on a v2.2 build.
    expect(FIRST_TRADE_RENT_SOL).toBe((portfolioAccountLen() === 9563 ? RENT : RENT_V22) / 1e9);
    expect(FIRST_TRADE_COPY.line).toBe("First trade on this market sets up your trading account (one approval, plus ~0.05 SOL one-time account rent)");
  });

  it("the confirm modal shows the rent row on a first trade, and not otherwise", () => {
    const props = {
      direction: "long" as const, positionSize: 1_000_000n, margin: 1_000_000n, leverage: 2, estimatedLiqPrice: 0n,
      tradingFee: 1_000n, symbol: "SOL", decimals: 6, onConfirm: () => {}, onCancel: () => {},
    };
    const { unmount } = render(<TradeConfirmationModal {...props} createsAccount />);
    expect(screen.getByTestId("confirm-account-rent")).toHaveTextContent("Account setup (one-time):~0.05 SOL");
    unmount();
    render(<TradeConfirmationModal {...props} />);
    expect(screen.queryByTestId("confirm-account-rent")).toBeNull();
  });

  it("CONTROL: a plain fee shortfall keeps the existing network-fees line", () => {
    const u = resolveUserMessage(new Error("Transfer: insufficient lamports 100, need 5000"), { surface: "trade", side: "long", symbol: "SOL" });
    expect(u.title).toBe("Need network fees");
  });
});
