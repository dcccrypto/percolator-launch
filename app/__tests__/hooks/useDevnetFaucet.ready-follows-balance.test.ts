/**
 * The Fund Your Account modal showed "USDC 0 · Get USDC ✓ Ready". usdcDone / solDone were latched:
 * once one balance read crossed the threshold they stayed true for the session, so after the wallet
 * spent or deposited its Sim-USDC the modal (which reopens below 1,000 USDC) called the step done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
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
beforeEach(() => {
  rpc.wallet = WALLET;
  rpc.gate = null;
  rpc.usdcByWallet = null;
  process.env = { ...env, NEXT_PUBLIC_SOLANA_NETWORK: "devnet" };
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("Fund Your Account: Ready follows the current balance", () => {
  it("USDC: done at 2,000, not done after the wallet drops to 0", async () => {
    rpc.lamports = 2_500_000_000; // 2.5 SOL
    rpc.usdcAtoms = "2000000000"; // 2,000 USDC
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcBalance).toBe(2000);
    expect(result.current.usdcDone).toBe(true);

    rpc.usdcAtoms = "0"; // deposited / traded away
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcBalance).toBe(0);
    expect(result.current.shouldShow).toBe(true); // the modal reopens below 1,000 USDC…
    expect(result.current.usdcDone).toBe(false); // …and must not call the USDC step done
  });

  it("after this modal's airdrop, a lagging read of 0 keeps the step done until the funds show", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "0";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ funded: true }), { status: 200 })));
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropUsdc(); }); // its own refresh still reads 0
    expect(result.current.usdcBalance).toBe(0);
    expect(result.current.usdcDone).toBe(true);

    rpc.usdcAtoms = "10000000000"; // the airdrop lands
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcDone).toBe(true);
    rpc.usdcAtoms = "0"; // then spent: back to following the balance
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcDone).toBe(false);
  });

  it("SOL: same", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "0";
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.solDone).toBe(true);
    rpc.lamports = 10_000_000; // 0.01 SOL
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.solDone).toBe(false);
  });

  it("a wallet with no token account yet reads 0 and clears the step", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "2000000000";
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcDone).toBe(true);
    rpc.usdcAtoms = null; // "could not find account"
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcBalance).toBe(0);
    expect(result.current.usdcDone).toBe(false);
  });

  it("a read for the previous wallet that lands after a wallet switch is dropped", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "0";
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.refreshBalances(); });

    // WALLET holds 2,000 USDC, OTHER none. A slow read for WALLET is in flight when the user
    // switches to OTHER; OTHER's read lands first, WALLET's lands late.
    rpc.usdcByWallet = { [WALLET.toBase58()]: "2000000000", [OTHER.toBase58()]: "0" };
    let release!: () => void;
    rpc.gate = new Promise<void>((r) => { release = r; });
    let slowRead!: Promise<void>;
    act(() => { slowRead = result.current.refreshBalances(); });
    rpc.gate = null;
    rpc.wallet = OTHER;
    rerender();
    await act(async () => { await result.current.refreshBalances(); });
    await act(async () => { release(); await slowRead; });

    expect(result.current.usdcBalance).not.toBe(2000);
    expect(result.current.usdcDone).toBe(false);
  });

  it("a new PublicKey object for the same wallet is not a wallet change", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "2000000000";
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.refreshBalances(); });
    expect(result.current.usdcBalance).toBe(2000);
    rpc.wallet = new PublicKey(WALLET.toBase58());
    rerender();
    expect(result.current.usdcBalance).toBe(2000); // not reset to null
  });
});
