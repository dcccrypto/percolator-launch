/**
 * N21: after this modal funded the wallet, the balances passed the thresholds and the modal vanished
 * by itself. No dismissal was saved, so a deposit that took the wallet under 1,000 USDC brought the
 * full-screen modal back over the trade page, offering a claim the 24h gate refuses. Its own
 * "Start Trading" step was never seen. Harness from useDevnetFaucet.ready-follows-balance.test.ts.
 */
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
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }),
}));

const env = process.env;
const store = new Map<string, string>();
beforeEach(() => {
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

describe("Fund Your Account stays up after funding until the user closes it", () => {
  it("funded here: the modal stays on its done step; closing it saves the dismissal, so a deposit does not reopen it", async () => {
    rpc.lamports = 2_500_000_000; // 2.5 SOL
    rpc.usdcAtoms = "0";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ funded: true }), { status: 200 })));
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await waitFor(() => expect(result.current.shouldShow).toBe(true));

    rpc.usdcAtoms = "10000000000"; // the 10,000 USDC claim lands
    await act(async () => { await result.current.airdropUsdc(); });
    expect(result.current.usdcBalance).toBe(10_000);
    expect(result.current.shouldShow).toBe(true); // still up, on "Start Trading"

    act(() => result.current.dismiss());
    expect(result.current.shouldShow).toBe(false);
    expect([...store.keys()].some((k) => k.endsWith(WALLET.toBase58()))).toBe(true);

    rpc.usdcAtoms = "500000000"; // deposited 9,500 into a market
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.shouldShow).toBe(false);
  });

  it("SOL: a wallet with USDC but no SOL also stays on the done step after this modal's SOL claim", async () => {
    rpc.lamports = 0;
    rpc.usdcAtoms = "2000000000";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ signature: "sol-sig" }), { status: 200 })));
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
    rpc.lamports = 2_000_000_000; // the server's 2 SOL lands
    await act(async () => { await result.current.airdropSol(); });
    expect(result.current.solBalance).toBe(2);
    expect(result.current.shouldShow).toBe(true);
  });

  it("CONTROL: a wallet that was already funded never sees the modal", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "2000000000";
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcBalance).toBe(2000);
    expect(result.current.shouldShow).toBe(false);
  });

  it("CONTROL: a wallet switch after funding does not keep the modal up for the new, funded wallet", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "10000000000";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ funded: true }), { status: 200 })));
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropUsdc(); });
    expect(result.current.shouldShow).toBe(true);
    rpc.wallet = OTHER;
    rerender();
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.shouldShow).toBe(false);
  });
});
