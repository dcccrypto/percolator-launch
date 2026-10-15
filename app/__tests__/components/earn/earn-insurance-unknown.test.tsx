/**
 * S11 + S12: the Earn Insurance figure showed "$0" before it had been read. The hub's
 * Insurance Fund card took no loading state (the header's cell for the same figure does),
 * and the vault page fell back to `insuranceFund ?? 0` while the cells beside it show "—".
 */
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({ hasData: false, loading: false }));
vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [], tvl: 0, totalOI: 0, maxOI: 0, totalInsurance: S.hasData ? 1500 : 0 },
    loading: S.loading,
    error: S.hasData ? null : "Couldn't load vault data. Retrying every 15 seconds.",
    hasData: S.hasData,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

const insuranceCard = () => screen.getByRole("heading", { name: "Insurance Fund" }).parentElement!.parentElement!;
const figure = () => insuranceCard().querySelector(".text-lg")!.textContent;

describe("Earn hub Insurance Fund card (S11)", () => {
  it("cold load: '—', not $0", async () => {
    S.hasData = false;
    S.loading = true;
    render(<EarnVaultView />);
    await waitFor(() => expect(figure()).toBe("—"));
  });

  it("failed first load: still '—'", async () => {
    S.hasData = false;
    S.loading = false;
    render(<EarnVaultView />);
    await waitFor(() => expect(figure()).toBe("—"));
  });

  it("CONTROL: once read, the figure shows", async () => {
    S.hasData = true;
    S.loading = false;
    render(<EarnVaultView />);
    await waitFor(() => expect(figure()).toBe("$1.50K"));
  });
});

describe("Earn vault page Insurance cell (S12)", () => {
  const page = readFileSync(resolve(process.cwd(), "app/earn/[slab]/page.tsx"), "utf8");
  it("shows '—' until marketInfo resolves, like Open Interest and Max Leverage", () => {
    expect(page).not.toMatch(/insuranceFund \?\? 0/);
    expect(page).toContain('{marketInfo ? `$${formatCompact(marketInfo.insuranceFund / collDivisor)}` : "—"}');
  });
});
