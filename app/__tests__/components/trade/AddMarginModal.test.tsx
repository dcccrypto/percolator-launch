import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddMarginModal } from "../../../components/trade/PositionPanel";

const depositMock = vi.fn();

vi.mock("@/hooks/useDeposit", () => ({
  useDeposit: () => ({
    deposit: depositMock,
    loading: false,
    error: null,
  }),
}));

let walletBalance: bigint | null = 100_000_000n;
vi.mock("@/hooks/useWalletAtaBalance", () => ({
  useWalletAtaBalance: () => ({ balance: walletBalance, decimals: 6 }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ config: { collateralMint: null } }),
}));

describe("AddMarginModal", () => {
  it("refreshes the position after a successful margin deposit", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    depositMock.mockResolvedValueOnce("abc123456789");

    render(
      <AddMarginModal
        slabAddress="test-slab"
        userIdx={1}
        symbol="SOL"
        decimals={6}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("0.00 SOL"), {
      target: { value: "1.5" },
    });

    fireEvent.click(screen.getByRole("button", { name: /deposit margin/i }));

    await waitFor(() => {
      expect(depositMock).toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });
  it("blocks a deposit larger than the wallet balance (inline error, disabled submit)", () => {
    depositMock.mockClear();
    walletBalance = 2_000_000n; // 2.0 SOL
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("0.00 SOL"), { target: { value: "50" } });
    expect(screen.getByTestId("add-margin-amount-error").textContent).toMatch(/exceeds your wallet balance \(2 SOL available\)/i);
    const btn = screen.getByRole("button", { name: /deposit margin/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(depositMock).not.toHaveBeenCalled();
    // Max clamps to the balance and re-enables submit.
    fireEvent.click(screen.getByRole("button", { name: /^max:/i }));
    expect((screen.getByPlaceholderText("0.00 SOL") as HTMLInputElement).value).toBe("2");
    expect(btn.disabled).toBe(false);
    walletBalance = 100_000_000n;
  });

  it("N27: a decimal comma deposits 1.5, not 15", async () => {
    depositMock.mockReset();
    depositMock.mockResolvedValueOnce("sig");
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("0.00 SOL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1," } }); // typed on a comma keyboard
    fireEvent.change(input, { target: { value: input.value + "5" } });
    expect(input.value).toBe("1,5"); // shown as typed
    fireEvent.click(screen.getByRole("button", { name: /deposit margin/i }));
    await waitFor(() => expect(depositMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_500_000n })));
  });

  it("N27 follow-up: typing 1,000 key by key deposits 1000, not 1", async () => {
    depositMock.mockReset();
    depositMock.mockResolvedValueOnce("sig");
    walletBalance = 5_000_000_000n; // 5000 SOL
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("0.00 SOL") as HTMLInputElement;
    for (const k of "1,000") fireEvent.change(input, { target: { value: input.value + k } });
    expect(input.value).toBe("1,000");
    fireEvent.click(screen.getByRole("button", { name: /deposit margin/i }));
    await waitFor(() => expect(depositMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000_000n })));
    walletBalance = 100_000_000n;
  });

  it("does not allow submit while the wallet balance is still unknown", () => {
    walletBalance = null;
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("0.00 SOL"), { target: { value: "1" } });
    expect((screen.getByRole("button", { name: /deposit margin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("add-margin-amount-error").textContent).toMatch(/checking wallet balance/i);
    walletBalance = 100_000_000n;
  });
});
