/**
 * #3635/#3636 follow-ups (ledger pr5-2026-10-22): stale Earn copy under v2.2.
 *
 * - "Covers losses before they reach Earn deposits" (Insurance row) is not what the v2.2 wrapper does: a trading
 *   loss draws the creator's stake, then every Earn pot, and InsuranceBackstopDraw (tag 111) moves insurance into
 *   the vault LP only for a deficit LEFT with no drawable pot (feat/v22-rc23 handle_insurance_backstop_draw;
 *   decision 2026-09-30 "junior -> Earn seniors").
 * - "Deposit USDC" / "sim-USDC" on a page whose v2.2 vaults can hold other collateral (each vault's own token is
 *   named in its deposit rail).
 * Flag off: every v2.1 market shares one sim-USDC collateral, and the copy is unchanged.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { V22_COPY } from "@/lib/v22/copy";

vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [], tvl: 0, dailyFeeRevenue: 0, totalOI: 0, maxOI: 0, totalInsurance: 1500, unvaluedSymbols: [] },
    loading: false, error: null, hasData: true, refresh: vi.fn(),
  }),
}));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const header = async () => {
  const { EarnHeader } = await vi.importActual<typeof import("@/components/earn/EarnHeader")>("@/components/earn/EarnHeader");
  const stats = { markets: [], tvl: 1, dailyFeeRevenue: 1, totalInsurance: 1, totalOI: 0, maxOI: 0, unvaluedSymbols: [] } as never;
  render(<EarnHeader stats={stats} loading={false} />);
};
const text = (id: string) => document.getElementById(id)!.textContent ?? "";

describe("v2.2 on: Earn copy matches the program", () => {
  it("the Insurance row says trading losses reach Earn first, never that insurance covers them before Earn", () => {
    __setDevnetV22ForTest(true);
    render(<EarnVaultView />);
    const row = text("earn-info-insurance");
    expect(row).not.toMatch(/before they reach Earn/i);
    expect(row).toContain(V22_COPY.earnPage.insuranceOrder);
    expect(V22_COPY.earnPage.insuranceOrder).toMatch(/Earn deposits first/);
  });

  it("the header and How it works name no single collateral", async () => {
    __setDevnetV22ForTest(true);
    render(<EarnVaultView />);
    expect(text("earn-info-how")).not.toMatch(/USDC/);
    cleanup();
    await header();
    expect(screen.getByText(/added to the vault/).textContent).not.toMatch(/USDC/);
    expect(screen.getByText(/added to the vault/).textContent).toContain(V22_COPY.earnPage.depositLead);
  });
});

describe("flag off: unchanged", () => {
  it("keeps the v2.1 lines", async () => {
    __setDevnetV22ForTest(false);
    render(<EarnVaultView />);
    expect(text("earn-info-insurance")).toMatch(/Covers losses before they reach Earn deposits/);
    expect(text("earn-info-how")).toMatch(/Provide sim-USDC as counterparty backing/);
    cleanup();
    await header();
    expect(screen.getByText(/added to the vault/).textContent).toMatch(/^Deposit USDC into a market's vault\./);
  });
});
