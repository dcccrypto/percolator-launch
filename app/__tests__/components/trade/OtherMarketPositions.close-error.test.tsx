/**
 * "// other markets" Close modal: a failed close must show the hook's error
 * inside the still-open modal (CloseFlow previously never read `error`).
 * #24: its preview includes the market's trading fee, like the dock's.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const slab = vi.hoisted(() => ({ params: null as null | { tradingFeeBps: bigint } }));

vi.mock("@/hooks/useClosePosition", async () => {
  const React = await import("react");
  return {
    useClosePosition: () => {
      const [error, setError] = React.useState<string | null>(null);
      return {
        closePosition: async () => { setError("Transaction cancelled."); throw new Error("rejected"); },
        loading: false, error, phase: "idle", lastSig: null,
        resetPhase: () => setError(null), prewarmClose: () => {},
      };
    },
  };
});
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: false }) }));
vi.mock("@/hooks/usePortfolio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/usePortfolio")>()),
  usePortfolio: () => ({ positions: [], refresh: () => {} }),
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSlabState: () => ({ params: slab.params }),
}));
// Mock mode so getMockPortfolioPositions supplies the rows (the wallet is disconnected).
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => true }));

import { OtherMarketPositions } from "@/components/trade/OtherMarketPositions";

afterEach(() => { slab.params = null; });

describe("OtherMarketPositions close modal error", () => {
  it("shows a failed close's error inside the still-open modal", async () => {
    render(<OtherMarketPositions currentSlab="not-a-mock-slab" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await act(async () => { fireEvent.click(screen.getByTestId("close-confirm")); });
    const modal = screen.getByTestId("close-modal");
    expect(within(modal).getByTestId("close-error")).toHaveTextContent("Transaction cancelled.");
  });

  it("#24: the preview subtracts the market's trading fee", () => {
    slab.params = { tradingFeeBps: 10n };
    render(<OtherMarketPositions currentSlab="not-a-mock-slab" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    const modal = screen.getByTestId("close-modal");
    expect(within(modal).getByText("Trading Fee:")).toBeInTheDocument();
  });
});
