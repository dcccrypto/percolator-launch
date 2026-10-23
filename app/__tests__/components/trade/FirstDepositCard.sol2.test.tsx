/** SOL-2 (v2.2 QA 2026-10-11): a new user deposits without trading — one createAndDeposit call, nothing traded. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const createAndDeposit = vi.fn();
let impl: ((atoms: bigint) => Promise<unknown>) | null = null;
vi.mock("@/hooks/useFirstTrade", () => ({
  useFirstTrade: () => ({ createAndDeposit: (a: bigint) => (impl ? impl(a) : createAndDeposit(a)), fundAndTrade: vi.fn(), loading: false }),
}));

import { FirstDepositCard, FIRST_DEPOSIT_COPY } from "@/components/trade/FirstDepositCard";

const SLAB = "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5";
beforeEach(() => {
  createAndDeposit.mockReset();
  impl = null;
});

describe("FirstDepositCard", () => {
  it("deposits the typed amount in one call and shows the tx", async () => {
    createAndDeposit.mockResolvedValue({ signature: "5rSVz74bS61VKSZr3WyHN7SSRe2aUvjFob2YyPH11QUh", portfolio: null, created: true });
    render(<FirstDepositCard slabAddress={SLAB} walletBalance={100_000_000n} decimals={6} symbol="USDC" />);
    fireEvent.change(screen.getByTestId("first-deposit-amount"), { target: { value: "25" } });
    fireEvent.click(screen.getByTestId("first-deposit-submit"));
    await waitFor(() => expect(createAndDeposit).toHaveBeenCalledWith(25_000_000n));
    expect(await screen.findByTestId("first-deposit-done")).toHaveTextContent(FIRST_DEPOSIT_COPY.done);
  });
  it("NEGATIVE CONTROLS: empty and over-balance amounts never call the chain", async () => {
    render(<FirstDepositCard slabAddress={SLAB} walletBalance={10_000_000n} decimals={6} symbol="USDC" />);
    fireEvent.click(screen.getByTestId("first-deposit-submit"));
    expect(await screen.findByTestId("first-deposit-error")).toHaveTextContent(FIRST_DEPOSIT_COPY.empty);
    fireEvent.change(screen.getByTestId("first-deposit-amount"), { target: { value: "11" } });
    fireEvent.click(screen.getByTestId("first-deposit-submit"));
    expect(await screen.findByTestId("first-deposit-error")).toHaveTextContent("more than your wallet holds");
    expect(createAndDeposit).not.toHaveBeenCalled();
  });
  it("a wallet rejection shows no error", async () => {
    let settled = false;
    impl = async () => {
      settled = true;
      throw new Error("User rejected the request.");
    };
    render(<FirstDepositCard slabAddress={SLAB} walletBalance={10_000_000n} decimals={6} symbol="USDC" />);
    fireEvent.change(screen.getByTestId("first-deposit-amount"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("first-deposit-submit"));
    await waitFor(() => expect(settled).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("first-deposit-error")).toBeNull();
  });
});
