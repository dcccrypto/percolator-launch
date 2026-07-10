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
});
