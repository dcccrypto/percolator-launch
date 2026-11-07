/**
 * Council 2026-11-06-go1106-ux, LP (low), reproduced by seats/lp/scripts/lp-break.mts on the preview:
 *   earn deposit "-5"  -> input="5"  Deposit enabled=true
 *   earn deposit "1e3" -> input="13" Deposit enabled=true
 *   earn deposit "0.0000001" -> Deposit enabled=false, no message
 * The field must keep what was typed, say what is wrong, and keep Deposit disabled.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DepositWithdrawPanel } from "../../../components/earn/DepositWithdrawPanel";

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({ connected: true })),
  useConnectionCompat: () => ({ connection: {} }),
}));

vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

const props = {
  userBalance: 10_000_000_000n, // 10,000 USDC
  userLpBalance: 0n,
  vaultBalance: 0n,
  lpSupply: 0n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  onDeposit: vi.fn(async () => undefined),
  onWithdraw: vi.fn(async () => undefined),
};

function type(value: string) {
  const input = screen.getByTestId("earn-deposit-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("Earn deposit amount: malformed input is refused, not rewritten", () => {
  it('"-5" stays "-5", says amounts cannot be negative, and Deposit is disabled', () => {
    render(<DepositWithdrawPanel {...props} />);
    const input = type("-5");
    expect(input.value).toBe("-5");
    expect(screen.getByTestId("earn-amount-input-error")).toHaveTextContent(/negative/i);
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it('"1e3" stays "1e3" (not 13), asks for the full number, and Deposit is disabled', () => {
    render(<DepositWithdrawPanel {...props} />);
    const input = type("1e3");
    expect(input.value).toBe("1e3");
    expect(screen.getByTestId("earn-amount-input-error")).toHaveTextContent(/full number/i);
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
    expect(screen.queryByTestId("earn-deposit-preview")).not.toBeInTheDocument();
  });

  it('"0.0000001" says the smallest amount instead of a silent disabled button', () => {
    render(<DepositWithdrawPanel {...props} />);
    type("0.0000001");
    expect(screen.getByTestId("earn-amount-input-error")).toHaveTextContent("smallest amount is 0.000001 USDC");
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
  });

  it("other malformed text is refused too", () => {
    render(<DepositWithdrawPanel {...props} />);
    for (const raw of ["+5", "5 USDC", "0x10"]) {
      type(raw);
      expect(screen.getByTestId("earn-amount-input-error"), raw).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deposit" }), raw).toBeDisabled();
    }
  });

  it("fixing the text clears the error and a well-formed amount enables Deposit", () => {
    render(<DepositWithdrawPanel {...props} />);
    type("-5");
    type("5");
    expect(screen.queryByTestId("earn-amount-input-error")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
  });

  it("a decimal comma and thousands grouping still work (no regression of the comma rule)", () => {
    render(<DepositWithdrawPanel {...props} />);
    const input = type("1,000");
    expect(input.value).toBe("1,000");
    expect(screen.queryByTestId("earn-amount-input-error")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
  });
});

// Council 2026-11-07 council-leftovers run 2, #4/#5/#13: separators were still rewritten (1.2.3 → 1.23, 1,000,00 →
// 100000) with Deposit enabled, and a comma amount was never echoed. Typed text stays, no amount, Deposit disabled.
describe("Earn deposit amount: repeated or misplaced separators (run 2)", () => {
  it.each(["1.2.3", "1..5", "1,2,3", "1,000.5.5", "1,000,00"])("%s is refused as typed and Deposit stays disabled", (raw) => {
    render(<DepositWithdrawPanel {...props} />);
    const input = type(raw);
    expect(input.value).toBe(raw);
    expect(screen.getByTestId("earn-amount-input-error")).toHaveTextContent(/decimal point|comma/i);
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
    expect(screen.queryByTestId("earn-deposit-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("earn-amount-echo")).not.toBeInTheDocument();
  });

  it('"5e-1" gets the full-number reason, not "negative"', () => {
    render(<DepositWithdrawPanel {...props} />);
    type("5e-1");
    expect(screen.getByTestId("earn-amount-input-error")).toHaveTextContent(/full number/i);
    expect(screen.getByTestId("earn-amount-input-error")).not.toHaveTextContent(/negative/i);
  });

  it('"1,500" is echoed as 1500 with the 1.5 reading named; "1,5" is echoed as 1.5', () => {
    render(<DepositWithdrawPanel {...props} />);
    type("1,500");
    expect(screen.getByTestId("earn-amount-echo")).toHaveTextContent("Reads as 1500 USDC. For 1.5 USDC, type 1.5.");
    expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
    type("1,5");
    expect(screen.getByTestId("earn-amount-echo")).toHaveTextContent("Reads as 1.5 USDC.");
    expect(screen.getByTestId("earn-amount-echo")).not.toHaveTextContent("For ");
    type("25");
    expect(screen.queryByTestId("earn-amount-echo")).not.toBeInTheDocument();
  });

  it("typing and pasting the same text read the same amount (1.000.000 was 1 typed, 1,000,000 pasted)", () => {
    render(<DepositWithdrawPanel {...props} />);
    for (const step of ["1", "1.", "1.0", "1.00", "1.000", "1.000.", "1.000.0", "1.000.00", "1.000.000"]) type(step);
    const typed = screen.getByTestId("earn-amount-input-error").textContent;
    type("");
    type("1.000.000");
    expect(screen.getByTestId("earn-amount-input-error").textContent).toBe(typed);
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
  });

  it("a refused amount does not follow the user to the Withdraw tab", () => {
    render(<DepositWithdrawPanel {...props} />);
    type("-5");
    expect(screen.getByTestId("earn-amount-input-error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^withdraw$/i }));
    expect(screen.queryByTestId("earn-amount-input-error")).not.toBeInTheDocument();
    expect((screen.getByTestId("earn-withdraw-input") as HTMLInputElement).value).toBe("");
  });
});
