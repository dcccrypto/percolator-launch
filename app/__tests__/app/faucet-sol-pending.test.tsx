/**
 * #49: when the server's SOL top-up was broadcast but not confirmed, /api/playground/faucet returns
 * `sol_pending: true` with `sol_airdropped: false`. The page read only `sol_airdropped` and told the
 * user the airdrop was skipped and to get SOL from faucet.solana.com, while the SOL was on its way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const WALLET = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const fetchMock = vi.fn();

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: true, publicKey: WALLET }) }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => false, usePrivyLogin: () => () => {} }));
vi.mock("@/components/playground/SimUsdcBalance", () => ({ SimUsdcBalance: () => null }));
vi.mock("@/components/wallet/ConnectButton", () => ({ ConnectButton: () => null }));

import FaucetPage from "@/app/faucet/page";

const base = { funded: true, usdc_amount: 10_000, usdc_sig: "usdcsig111", nextClaimAt: new Date(Date.now() + 3_600_000).toISOString() };

async function claim(body: Record<string, unknown>) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...base, ...body }) });
  render(<FaucetPage />);
  fireEvent.click(screen.getByRole("button", { name: /Get 10,000 Sim-USDC/ }));
  await screen.findByText(/Sim-USDC minted/);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#49: faucet SOL line", () => {
  it("a pending server top-up says it's on its way, not 'skipped, go elsewhere'", async () => {
    await claim({ sol_airdropped: false, sol_pending: true, sol_sig: "pendingsig99", sol_source: "server", sol_amount: 0 });
    expect(screen.getByText(/on its way but not confirmed yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "pendings..." }).getAttribute("href")).toContain("/pendingsig99?cluster=devnet");
    expect(screen.queryByText(/skipped/)).toBeNull();
    expect(screen.queryByRole("link", { name: "faucet.solana.com" })).toBeNull();
  });

  it("a real miss still points to faucet.solana.com", async () => {
    await claim({ sol_airdropped: false, sol_amount: 0 });
    expect(screen.getByText(/skipped/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "faucet.solana.com" })).toBeTruthy();
    expect(screen.queryByText(/on its way/)).toBeNull();
  });

  it("a sent top-up links its transaction and shows neither message", async () => {
    await claim({ sol_airdropped: true, sol_sig: "sentsig12345", sol_source: "server", sol_amount: 0.05 });
    expect(screen.getByRole("link", { name: "sentsig1..." })).toBeTruthy();
    expect(screen.queryByText(/skipped|on its way/)).toBeNull();
  });
});
