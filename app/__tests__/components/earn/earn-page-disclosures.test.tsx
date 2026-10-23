/**
 * The Earn page leads with what Earn does; the detail opens on request. The full fee split sits
 * behind a toggle in the header, and How it works / Insurance fund / Risk notice are rows that start
 * closed, with at most one open at a time.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [], tvl: 0, dailyFeeRevenue: 0, totalOI: 0, maxOI: 0, totalInsurance: 1500, unvaluedSymbols: [] },
    loading: false,
    error: null,
    hasData: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));

import { EarnVaultView } from "@/components/earn/EarnVaultView";


const header = async () => {
  const { EarnHeader } = await vi.importActual<typeof import("@/components/earn/EarnHeader")>("@/components/earn/EarnHeader");
  const stats = { markets: [], tvl: 1, dailyFeeRevenue: 1, totalInsurance: 1, totalOI: 0, maxOI: 0, unvaluedSymbols: [] } as never;
  render(<EarnHeader stats={stats} loading={false} />);
};

describe("Earn header", () => {
  it("says what Earn does in one sentence, with the vault's share", async () => {
    await header();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Earn from trading fees");
    expect(screen.getByText(/48% of every trading fee on that market is\s+added to the vault/)).toBeTruthy();
  });

  it("states the downside without any click (the Risk notice row starts closed)", async () => {
    await header();
    const line = screen.getByTestId("earn-loss-line");
    expect(line.closest("[hidden]")).toBeNull();
    expect(line.textContent).toMatch(/fall when traders win/);
    expect(line.textContent).toMatch(/only deposit what you can afford to lose/i);
  });

  it("keeps the full fee split closed until asked for, then opens and closes it", async () => {
    await header();
    const toggle = screen.getByTestId("earn-fee-split-toggle");
    const split = screen.getByTestId("earn-fee-split");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(split.id);
    expect(split.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(split.hidden).toBe(false);
    // Every destination is still there once opened.
    for (const label of ["Earn deposits", "Protocol", "Market creator", "Insurance fund"]) {
      expect(split.textContent).toContain(label);
    }
    fireEvent.click(toggle);
    expect(split.hidden).toBe(true);
  });
});

describe("Earn info rows", () => {
  const button = (name: RegExp) => screen.getByRole("button", { name });
  const panel = (id: string) => document.getElementById(`earn-info-${id}`)!;

  it("start closed, with the insurance figure readable without opening", () => {
    render(<EarnVaultView />);
    for (const id of ["how", "insurance", "risk"]) expect(panel(id).hidden).toBe(true);
    expect(screen.getByTestId("earn-insurance-figure").textContent).toBe("$1.50K");
  });

  it("open one at a time: opening another closes the first", () => {
    render(<EarnVaultView />);
    fireEvent.click(button(/How it works/));
    expect(panel("how").hidden).toBe(false);
    expect(button(/How it works/).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button(/Risk notice/));
    expect(panel("risk").hidden).toBe(false);
    expect(panel("how").hidden).toBe(true);
    expect(button(/How it works/).getAttribute("aria-expanded")).toBe("false");
    expect(panel("risk").textContent).toMatch(/only deposit what you can afford to lose/i);

    fireEvent.click(button(/Insurance fund/));
    expect(panel("insurance").hidden).toBe(false);
    expect(panel("risk").hidden).toBe(true);
  });

  it("clicking the open row again closes it", () => {
    render(<EarnVaultView />);
    fireEvent.click(button(/Insurance fund/));
    fireEvent.click(button(/Insurance fund/));
    for (const id of ["how", "insurance", "risk"]) expect(panel(id).hidden).toBe(true);
  });

  it("each row's button controls its own labelled region", () => {
    render(<EarnVaultView />);
    for (const id of ["how", "insurance", "risk"]) {
      const b = document.getElementById(`earn-info-${id}-button`)!;
      expect(b.getAttribute("aria-controls")).toBe(`earn-info-${id}`);
      expect(panel(id).getAttribute("role")).toBe("region");
      expect(panel(id).getAttribute("aria-labelledby")).toBe(b.id);
    }
  });
});
