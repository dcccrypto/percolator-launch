/**
 * R10 review M3: the one-render arming guard. (Original note: the "Fund Your Account" modal popped over the trade page while a position was
 * open (wallet USDC low), covering the dock Close button, and came back on every page load. It never opens now
 * while the wallet has an open position, or while that is still unknown. A new wallet (no position) still gets it.
 * Harness from useDevnetFaucet.funded-stays-open.test.ts.
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
// Mimics the real usePortfolio: on the render where `enabled` flips true it still says loading=false, no positions;
// its effect then starts the scan (loading) and a moment later it lands with one open position.
vi.mock("@/hooks/usePortfolio", async () => {
  const React = await import("react");
  return {
    usePortfolio: (enabled: boolean) => {
      const [loading, setLoading] = React.useState(false);
      const [positions, setPositions] = React.useState<{ account: { positionSize: bigint } }[]>([]);
      React.useEffect(() => {
        if (!enabled) { setLoading(false); setPositions([]); return; }
        setLoading(true);
        const t = setTimeout(() => { setPositions([{ account: { positionSize: 5n } }]); setLoading(false); }, 30);
        return () => clearTimeout(t);
      }, [enabled]);
      return { positions, loading, error: null };
    },
    isOpenPosition: (p: { account?: { positionSize: bigint } }) => (p.account?.positionSize ?? 0n) !== 0n,
  };
});
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

describe("Fund Your Account: the first render after the scan is armed is not 'no positions'", () => {
  it("never shows at any render while a position exists but the scan has not landed", async () => {
    rpc.lamports = 2_500_000_000;
    rpc.usdcAtoms = "25000000"; // low USDC, wallet funded for SOL
    const { useDevnetFaucet } = await import("@/hooks/useDevnetFaucet");
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const f = useDevnetFaucet();
      seen.push(f.shouldShow);
      return f;
    });
    await waitFor(() => expect(result.current.usdcBalance).toBe(25));
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.some(Boolean)).toBe(false);
  });
});
