/**
 * Live report 2026-10-01: the creator's wizard seed showed "—" under "Your Deposit" until they
 * deposited again. The hub table only knew the deposit of the row bound to the rail. Every row now
 * reads the wallet's position from chain (useEarnPositions -> readEarnPositions).
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const SEEDED = "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh";
const FIRST = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const market = (slabAddress: string, symbol: string) => ({
  slabAddress, symbol, name: symbol, mainnetCa: null, vaultBalance: 9_000_000_000, totalOI: 0, maxOI: 0,
  insuranceFund: 0, tradingFeeBps: 10, maxLeverage: 10, oiUtilPct: 0, decimals: 6, hasVault: true,
});
vi.mock("@/hooks/useEarnStats", () => ({
  useEarnStats: () => ({
    stats: { markets: [market(FIRST, "PERCOLATOR"), market(SEEDED, "TRENDS")], tvl: 0, totalOI: 0, maxOI: 0, totalInsurance: 0 },
    loading: false, error: null, hasData: true, refresh: vi.fn(),
  }),
}));
// The rail is bound to the FIRST row (auto-selected) and has not reported anything.
vi.mock("@/components/earn/VaultDepositRail", () => ({ VaultDepositRail: () => null }));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));
const W = vi.hoisted(() => ({ conn: {}, wallet: null as unknown }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => (W.wallet ??= { publicKey: new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa") }),
  useConnectionCompat: () => ({ connection: W.conn }),
}));
vi.mock("@/lib/limits/earn-positions", () => ({
  readEarnPositions: vi.fn(async () => new Map([[SEEDED, { shares: 1_999_999_000n, valueAtoms: 2_002_964_375n }], [FIRST, { shares: 0n, valueAtoms: 0n }]])),
}));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

describe("Earn hub: Your Deposit on every row", () => {
  it("shows the creator's seeded position on a row the rail is not bound to", async () => {
    render(<EarnVaultView />);
    expect(screen.queryByText(/\$2\.00K/i)).toBeNull(); // TVL is $9.00K: no false match
    await waitFor(() => expect(screen.getByText(/\$2\.00K/i)).toBeInTheDocument());
  });
});
