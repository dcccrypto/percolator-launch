/**
 * The rail's reported deposit belongs to the wallet it was read for: after a wallet switch or a
 * disconnect, "Your Deposit" must not keep showing the previous wallet's figure.
 */
import "@testing-library/jest-dom";
import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const FIRST = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const OTHER = "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh";
const market = (slabAddress: string, symbol: string) => ({
  slabAddress, symbol, name: symbol, mainnetCa: null, vaultBalance: 9_000_000_000, totalOI: 0, maxOI: 0,
  insuranceFund: 0, tradingFeeBps: 10, maxLeverage: 10, oiUtilPct: 0, decimals: 6, hasVault: true,
});
const STATS = {
  stats: { markets: [market(FIRST, "PERCOLATOR"), market(OTHER, "TRENDS")], tvl: 0, totalOI: 0, maxOI: 0, totalInsurance: 0 },
  loading: false, error: null, hasData: true, refresh: vi.fn(),
};
vi.mock("@/hooks/useEarnStats", () => ({ useEarnStats: () => STATS }));
vi.mock("@/components/earn/EarnHeader", () => ({ EarnHeader: () => null }));

const W = vi.hoisted(() => ({
  conn: {},
  wallet: { publicKey: null as unknown },
  report: null as null | { slab: string; usd: number },
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => W.wallet,
  useConnectionCompat: () => ({ connection: W.conn }),
}));
// Chain reads find nothing for any wallet, so every figure on screen comes from the rail.
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: vi.fn(async () => new Map()) }));
// The rail reports once per `report` value, like the real one reporting on a resolved change.
// It is bound to FIRST, the auto-selected row.
vi.mock("@/components/earn/VaultDepositRail", () => ({
  VaultDepositRail: ({ onPositionResolved }: { onPositionResolved: (slab: string, usd: number) => void }) => {
    const r = W.report;
    useEffect(() => {
      if (r) onPositionResolved(r.slab, r.usd);
    }, [r, onPositionResolved]);
    return null;
  },
}));

import { EarnVaultView } from "@/components/earn/EarnVaultView";

const A = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const B = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

describe("Earn hub: Your Deposit follows the connected wallet", () => {
  it("drops wallet A's rail-reported deposits after switching to B, then shows B's", async () => {
    W.wallet = { publicKey: A };
    W.report = { slab: FIRST, usd: 5_000 };
    const { rerender } = render(<EarnVaultView />);
    await waitFor(() => expect(screen.getByText(/\$5\.00K/i)).toBeInTheDocument());

    // Switch to B: the rail hasn't re-read yet, so it reports nothing new.
    W.wallet = { publicKey: B };
    rerender(<EarnVaultView />);
    expect(screen.queryByText(/\$5\.00K/i)).toBeNull();

    // B's own read lands.
    W.report = { slab: FIRST, usd: 3_000 };
    rerender(<EarnVaultView />);
    await waitFor(() => expect(screen.getByText(/\$3\.00K/i)).toBeInTheDocument());
    expect(screen.queryByText(/\$5\.00K/i)).toBeNull();
  });

  it("drops the deposits on disconnect", async () => {
    W.wallet = { publicKey: A };
    W.report = { slab: FIRST, usd: 5_000 };
    const { rerender } = render(<EarnVaultView />);
    await waitFor(() => expect(screen.getByText(/\$5\.00K/i)).toBeInTheDocument());
    W.wallet = { publicKey: null };
    rerender(<EarnVaultView />);
    expect(screen.queryByText(/\$5\.00K/i)).toBeNull();
  });
});
