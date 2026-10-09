/**
 * Earn hub after a failed first load (useEarnStats hasData false): the partly unread figures are
 * not shown as data. The table and header stay in their loading state; the error says it's retrying.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({ hasData: false }));
const market = (slabAddress: string, symbol: string) => ({
  slabAddress, symbol, name: symbol, mainnetCa: null, vaultBalance: 0, totalOI: 0, maxOI: 0,
  insuranceFund: 0, tradingFeeBps: 10, maxLeverage: 10, oiUtilPct: 0, decimals: 6, hasVault: true,
});
vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [market("9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn", "PERCOLATOR")], tvl: 0, totalOI: 0, maxOI: 0, totalInsurance: 0 },
    loading: false,
    error: S.hasData ? null : "Couldn't load vault data. Retrying every 15 seconds.",
    hasData: S.hasData,
    refresh: vi.fn(),
  }),
}));
const header = vi.hoisted(() => vi.fn((_p: { loading: boolean }) => null));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: header }));
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

describe("Earn hub: a failed first load", () => {
  it("keeps the loading state (no unread figures as data) and shows the retrying message", async () => {
    header.mockClear();
    render(<EarnVaultView />);
    // EarnHeader is loaded through next/dynamic, so it has not rendered on the first synchronous pass.
    await waitFor(() => expect(header.mock.calls.length).toBeGreaterThan(0));
    expect(header.mock.calls.at(-1)![0].loading).toBe(true);
    expect(screen.queryByText("PERCOLATOR")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load vault data. Retrying every 15 seconds.");
  });

  it("CONTROL: once a read has succeeded the vaults show", async () => {
    S.hasData = true;
    header.mockClear();
    render(<EarnVaultView />);
    await waitFor(() => expect(header.mock.calls.length).toBeGreaterThan(0));
    expect(header.mock.calls.at(-1)![0].loading).toBe(false);
    expect(screen.getAllByText("PERCOLATOR").length).toBeGreaterThan(0);
  });
});
