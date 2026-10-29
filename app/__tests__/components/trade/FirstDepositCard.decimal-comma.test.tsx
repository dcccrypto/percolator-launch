/** #3575: the first-deposit field was the one amount field left on the old sanitiser (digits and "." only): "1,5" became 15. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const createAndDeposit = vi.fn();
vi.mock("@/hooks/useFirstTrade", () => ({
  useFirstTrade: () => ({ createAndDeposit: (a: bigint) => createAndDeposit(a), fundAndTrade: vi.fn(), loading: false }),
}));
import { FirstDepositCard } from "@/components/trade/FirstDepositCard";

beforeEach(() => createAndDeposit.mockReset().mockResolvedValue({ signature: "5rSVz74bS61VKSZr3WyHN7SSRe2aUvjFob2YyPH11QUh", portfolio: null, created: true }));

const deposit = async (typed: string) => {
  render(<FirstDepositCard slabAddress="BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5" walletBalance={100_000_000n} decimals={6} symbol="USDC" />);
  fireEvent.change(screen.getByTestId("first-deposit-amount"), { target: { value: typed } });
  fireEvent.click(screen.getByTestId("first-deposit-submit"));
  await waitFor(() => expect(createAndDeposit).toHaveBeenCalled());
  return createAndDeposit.mock.calls[0][0] as bigint;
};

describe("FirstDepositCard reads a decimal comma", () => {
  it("1,5 deposits 1.5 USDC, not 15", async () => {
    expect(await deposit("1,5")).toBe(1_500_000n);
  });
  it("CONTROL: a decimal point and a plain whole number are unchanged", async () => {
    expect(await deposit("2.5")).toBe(2_500_000n);
  });
  it("a typed comma stays visible while typing (1, then 1,5)", () => {
    render(<FirstDepositCard slabAddress="BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5" walletBalance={100_000_000n} decimals={6} symbol="USDC" />);
    const el = screen.getByTestId("first-deposit-amount") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "1," } });
    expect(el.value).toBe("1,");
    fireEvent.change(el, { target: { value: "1,5" } });
    expect(el.value).toBe("1,5");
  });
});
