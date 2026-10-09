/**
 * Dismissing the Earn error toast hid that message for good: after a successful refresh, the
 * same failure later showed no toast, so stale figures went unflagged. A dismissal now lasts
 * until the error clears.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({ error: null as string | null }));
vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [], tvl: 0, totalOI: 0, maxOI: 0, oiUtilPct: 0, totalInsurance: 0, dailyFeeRevenue: 0 },
    loading: false, error: S.error, hasData: true, refresh: vi.fn(),
  }),
}));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

const STALE = "Failed to refresh on-chain data — showing last known values";

describe("Earn error toast", () => {
  // #50: on a phone the fixed tab bar (3.5rem + safe area, below md) covered a bottom-4 toast.
  it("sits above the mobile tab bar below md, and at bottom-4 from md up", () => {
    S.error = STALE;
    render(<EarnVaultView />);
    const cls = screen.getByTestId("earn-error").className.split(/\s+/);
    expect(cls).toContain("bottom-[calc(3.5rem+1rem+env(safe-area-inset-bottom,0px))]");
    expect(cls).toContain("md:bottom-4");
    expect(cls).not.toContain("bottom-4");
  });

  it("shows the same failure again after a good refresh, even though it was dismissed before", () => {
    S.error = STALE;
    const { rerender } = render(<EarnVaultView />);
    fireEvent.click(screen.getByLabelText("Dismiss error"));
    expect(screen.queryByTestId("earn-error")).toBeNull();

    S.error = null; // a refresh succeeds
    rerender(<EarnVaultView />);
    S.error = STALE; // later, it fails again
    rerender(<EarnVaultView />);
    expect(screen.getByTestId("earn-error").textContent).toContain(STALE);
  });

  it("CONTROL: while the same failure continues, a dismissal holds", () => {
    S.error = STALE;
    const { rerender } = render(<EarnVaultView />);
    fireEvent.click(screen.getByLabelText("Dismiss error"));
    rerender(<EarnVaultView />);
    expect(screen.queryByTestId("earn-error")).toBeNull();
  });
});
