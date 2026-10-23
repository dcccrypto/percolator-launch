/**
 * #3612: the exit payout is the change in the wallet's collateral balance. The hook's "before" read must tell a
 * MISSING token account (a real 0) from a read that FAILED (429, timeout): only the first may count as 0.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const conn = {
  getProgramAccounts: vi.fn(async () => []),
  getMultipleAccountsInfo: vi.fn(async () => []),
  getAccountInfo: vi.fn(),
  getTokenAccountBalance: vi.fn(),
};
const quoteExit = vi.fn();
vi.mock("@/lib/v22/earn-exit-run", () => ({ quoteExit: (...a: unknown[]) => quoteExit(...a), sendExit: vi.fn(), withExitBudget: (x: unknown) => x }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: pk(9) }), useConnectionCompat: () => ({ connection: conn }) }));
vi.mock("@/lib/limits/earn-p3-read", () => ({ readEarnP3Context: async () => ({ bound: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddress: async () => pk(7) }));
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<Record<string, unknown>>()), deriveVaultAuthority: () => [pk(5), 1], deriveInsuranceLpMint: () => [pk(6), 1] }));
vi.mock("@/lib/tx-v1/user-bundle", () => ({ sendUserBundle: vi.fn() }));

import { useEarnExitV22 } from "@/hooks/useEarnExitV22";

const params = { market: pk(1), programId: pk(2), collateralMint: pk(3), sourceDomain: 0, shares: 100n, mode: "pair" as const, estimateAtoms: 0n };
/** A 165-byte SPL token account holding `amount`. */
const tokenAccount = (amount: bigint) => {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { data, owner: pk(4), lamports: 2_039_280, executable: false, rentEpoch: 0 };
};

/** The hook's `readDestBalance`, taken from the deps it hands the runner. */
async function readBalance(): Promise<() => Promise<bigint>> {
  let read: (() => Promise<bigint>) | null = null;
  quoteExit.mockImplementation(async (_input: unknown, deps: { readDestBalance: () => Promise<bigint> }) => {
    read = deps.readDestBalance;
    return { status: "wait-for-sweep", staleCount: 0 };
  });
  const { result } = renderHook(() => useEarnExitV22(params));
  await act(async () => void (await result.current.getQuote()));
  if (!read) throw new Error("the runner was never called");
  return read;
}

beforeEach(() => {
  quoteExit.mockReset();
  conn.getAccountInfo.mockReset();
  conn.getTokenAccountBalance.mockReset();
});

describe("#3612 readDestBalance", () => {
  it("a FAILED read (network / 429) rejects: it is never counted as an empty balance", async () => {
    const boom = new Error("429 Too Many Requests https://devnet.helius-rpc.com/?api-key=SECRET");
    conn.getAccountInfo.mockRejectedValue(boom);
    conn.getTokenAccountBalance.mockRejectedValue(boom);
    const read = await readBalance();
    await expect(read()).rejects.toThrow();
  });
  it("a MISSING token account is a real 0", async () => {
    conn.getAccountInfo.mockResolvedValue(null);
    conn.getTokenAccountBalance.mockRejectedValue(new Error("failed to get token account balance: Invalid param: could not find account"));
    const read = await readBalance();
    await expect(read()).resolves.toBe(0n);
  });
  it("an existing account reads its amount", async () => {
    conn.getAccountInfo.mockResolvedValue(tokenAccount(5_000_000_000n));
    conn.getTokenAccountBalance.mockResolvedValue({ context: { slot: 1 }, value: { amount: "5000000000", decimals: 6, uiAmount: 5000 } });
    const read = await readBalance();
    await expect(read()).resolves.toBe(5_000_000_000n);
  });
  it("an account whose data is not a token account rejects (unreadable, not 0)", async () => {
    conn.getAccountInfo.mockResolvedValue({ ...tokenAccount(0n), data: Buffer.alloc(8) });
    conn.getTokenAccountBalance.mockRejectedValue(new Error("Invalid param: not a Token account"));
    const read = await readBalance();
    await expect(read()).rejects.toThrow();
  });
});
