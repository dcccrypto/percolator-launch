/**
 * R10 (Council r9 trader, low): the "Fund Your Account" modal popped over the trade page while a position was
 * open (wallet USDC low), covering the dock Close button, and came back on every page load. It never opens now
 * while the wallet has an open position, or while that is still unknown. A new wallet (no position) still gets it.
 * Harness from useDevnetFaucet.funded-stays-open.test.ts.
 */
import { portfolioState, resetPortfolioState } from "./helpers/portfolio-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const WALLET = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const OTHER = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const rpc = vi.hoisted(() => ({
  usdcAtoms: "0" as string | null, // null: the token account doesn't exist yet
  lamports: 0,
  wallet: null as unknown, // the connected wallet (set per test)
  gate: null as Promise<void> | null, // reads started while it's set wait for it
  // Per-wallet USDC (by owner address), for the wallet-switch case; falls back to usdcAtoms.
  usdcByWallet: null as Record<string, string> | null,
}));

vi.mock("@/hooks/useWalletCompat", () => {
  const connection = {
    getBalance: async () => {
      const lamports = rpc.lamports;
      const gate = rpc.gate; // only reads started while the gate is set wait on it
      if (gate) await gate;
      return lamports;
    },
    // The ATA stub below returns the owner, so the account address identifies the wallet.
    getTokenAccountBalance: async (ata: { toBase58(): string }) => {
      const atoms = rpc.usdcByWallet ? rpc.usdcByWallet[ata.toBase58()] : rpc.usdcAtoms;
      const gate = rpc.gate;
      if (gate) await gate;
      if (atoms === null) throw new Error("failed to get token account balance: could not find account");
      return { value: { amount: atoms } };
    },
  };
  return {
    useWalletCompat: () => ({ publicKey: rpc.wallet, connected: true }),
    useConnectionCompat: () => ({ connection }),
  };
});
// getAssociatedTokenAddressSync fails jsdom's realm-split Uint8Array check; the address isn't
// what's under test, so stub it.
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: (_mint: unknown, owner: unknown) => owner,
}));
vi.mock("@/hooks/usePortfolio", async () => await import("./helpers/portfolio-mock"));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }),
}));

const env = process.env;
const store = new Map<string, string>();
beforeEach(() => {
  resetPortfolioState();
  rpc.wallet = WALLET;
  rpc.gate = null;
  rpc.usdcByWallet = null;
  process.env = { ...env, NEXT_PUBLIC_SOLANA_NETWORK: "devnet" };
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("Fund Your Account never opens over an open position", () => {
  async function mount() {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "25000000"; // 25 USDC: low
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    return renderHook(() => useDevnetFaucet());
  }

  it("open position + low USDC: stays closed", async () => {
    portfolioState.positions = [{ account: { positionSize: 5n } }];
    const { result } = await mount();
    await waitFor(() => expect(result.current.usdcBalance).toBe(25));
    expect(result.current.shouldShow).toBe(false);
  });

  it("a position opened while the modal was up closes it", async () => {
    const { result, rerender } = await mount();
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
    portfolioState.positions = [{ account: { positionSize: -3n } }];
    rerender();
    expect(result.current.shouldShow).toBe(false);
  });

  it("positions not read yet: stays closed", async () => {
    portfolioState.loading = true;
    const { result } = await mount();
    await waitFor(() => expect(result.current.usdcBalance).toBe(25));
    expect(result.current.shouldShow).toBe(false);
  });

  it("positions failed to load: stays closed (unknown is not 'no position')", async () => {
    portfolioState.error = "rpc down";
    const { result } = await mount();
    await waitFor(() => expect(result.current.usdcBalance).toBe(25));
    expect(result.current.shouldShow).toBe(false);
  });

  it("closed (zero-size) positions do not block it", async () => {
    portfolioState.positions = [{ account: { positionSize: 0n } }];
    const { result } = await mount();
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
  });

  it("CONTROL: new wallet, no position, low USDC: opens", async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
  });
});
