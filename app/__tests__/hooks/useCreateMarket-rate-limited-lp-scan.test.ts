/**
 * The LP step opens with a getProgramAccounts scan; a rate-limited RPC used to fail the launch there with
 * an opaque message and no retry. It is now retried three times with backoff, and if every try is refused
 * the creator is told the request was rate-limited and nothing was sent.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(), getAccountInfo: vi.fn(), getProgramAccounts: vi.fn(), getAccount: vi.fn(), deriveVaultAuthority: vi.fn(), getAssociatedTokenAddress: vi.fn(),
  connection: null as unknown as Record<string, unknown>, wallet: null as unknown as Record<string, unknown>, config: null as unknown as Record<string, unknown>,
}));
vi.mock("@solana/web3.js", async (orig) => {
  const a = await orig<typeof import("@solana/web3.js")>();
  return { ...a, SystemProgram: { ...a.SystemProgram, createAccount: (p: { fromPubkey: PublicKey; newAccountPubkey: PublicKey }) => new a.TransactionInstruction({ programId: a.SystemProgram.programId, keys: [{ pubkey: p.fromPubkey, isSigner: true, isWritable: true }, { pubkey: p.newAccountPubkey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) }) } };
});
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: mocks.connection }), useWalletCompat: () => mocks.wallet }));
vi.mock("@/lib/tx", () => ({ sendTx: mocks.sendTx }));
vi.mock("@/lib/config", () => ({ getConfig: () => mocks.config, getNetwork: () => "mainnet" }));
vi.mock("@/lib/inFlightMarket", () => ({ saveInFlightMarket: vi.fn(), updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(), loadLastInFlightMarket: vi.fn(() => null) }));
vi.mock("@solana/spl-token", async () => ({ ...(await vi.importActual<object>("@solana/spl-token")), getAccount: mocks.getAccount, getAssociatedTokenAddress: mocks.getAssociatedTokenAddress }));
vi.mock("@percolatorct/sdk", async () => ({ ...(await vi.importActual<object>("@percolatorct/sdk")), deriveVaultAuthority: mocks.deriveVaultAuthority }));

import { useCreateMarket } from "@/hooks/useCreateMarket";
import { RATE_LIMITED_COPY } from "@/lib/rpc-rate-limit";

const SLAB = Keypair.generate();
const params = { mint: Keypair.generate().publicKey, initialPriceE6: 100_000_000n, lpCollateral: 1_000_000n, insuranceAmount: 100_000n, oracleFeed: "0".repeat(64), invert: false, tradingFeeBps: 10, initialMarginBps: 1_500, maxAccounts: 4_096, decimals: 6, symbol: "TEST", name: "Test Market", oracleMode: "admin" as const };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const wallet = Keypair.generate();
  const programId = new PublicKey("69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9");
  mocks.config = { programId: programId.toBase58(), matcherProgramId: new PublicKey("4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT").toBase58(), programsBySlabTier: undefined };
  mocks.connection = { getAccountInfo: mocks.getAccountInfo, getProgramAccounts: mocks.getProgramAccounts, getMinimumBalanceForRentExemption: async () => 1 };
  mocks.wallet = { publicKey: wallet.publicKey, connected: true, connecting: false, signTransaction: vi.fn(async (t) => t), signAllTransactions: vi.fn(async (t) => t), signMessage: vi.fn(), disconnect: vi.fn() };
  mocks.deriveVaultAuthority.mockReturnValue([new PublicKey(new Uint8Array(32).fill(23)), 255]);
  mocks.getAssociatedTokenAddress.mockResolvedValue(new PublicKey(new Uint8Array(32).fill(24)));
  mocks.getAccount.mockResolvedValue({ amount: 0n });
  const sdk = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  const slabData = Buffer.alloc(26_364);
  Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]).copy(slabData, 0);
  slabData.writeUInt16LE(sdk.V17_EXPECTED_VERSION, 8);
  mocks.getAccountInfo.mockResolvedValue({ data: slabData, executable: false, lamports: 1, owner: programId, rentEpoch: 0 });
  mocks.sendTx.mockRejectedValue(new Error("stop after the first transaction"));
});
afterEach(() => vi.useRealTimers());

async function runStep2() {
  const { result } = renderHook(() => useCreateMarket());
  act(() => result.current.restoreSlabKeypair(SLAB, SLAB.publicKey.toBase58()));
  let p!: Promise<void>;
  await act(async () => {
    p = result.current.create(params, 2) as unknown as Promise<void>;
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
  });
  return result;
}

describe("the LP-portfolio scan at the start of the liquidity step", () => {
  it("survives a rate-limited RPC: retried, then the launch goes on to build the first transaction", async () => {
    const rl = new Error("429 Too Many Requests");
    mocks.getProgramAccounts.mockRejectedValueOnce(rl).mockRejectedValueOnce(rl).mockResolvedValue([]);
    await runStep2();
    expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(3);
    expect(mocks.sendTx).toHaveBeenCalled(); // got past the scan to TX A
  });

  it("every try refused: the creator is told it was rate-limited, nothing was sent", async () => {
    mocks.getProgramAccounts.mockRejectedValue(new Error("429 Too Many Requests"));
    const result = await runStep2();
    expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(4);
    expect(mocks.sendTx).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain(RATE_LIMITED_COPY);
  });

  it("a non-rate-limit failure is not retried", async () => {
    mocks.getProgramAccounts.mockRejectedValue(new Error("account not found"));
    await runStep2();
    expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("both getProgramAccounts scans in the hook go through the retry helper", async () => {
    const { readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const src = readFileSync(`${process.cwd()}/hooks/useCreateMarket.ts`, "utf8");
    expect(src.match(/connection\.getProgramAccounts\(/g)?.length).toBe(2);
    expect(src.match(/withRateLimitRetry\(\(\) => connection\.getProgramAccounts\(/g)?.length).toBe(2);
  });
});
