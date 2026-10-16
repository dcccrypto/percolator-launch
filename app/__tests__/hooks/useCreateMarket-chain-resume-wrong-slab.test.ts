/**
 * #3267 (security review A): a creator whose browser holds an unfinished launch X opens
 * /create?resume=Y. The hook hydrates X's keypair on mount and create() prefers the keypair over
 * state.slabAddress, so Y's chain resume ran on X: the wallet would have signed LP init and deposits on
 * the wrong market with Y's pinned parameters. Every transaction a chain resume builds must name Y.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(), getAccountInfo: vi.fn(), getProgramAccounts: vi.fn(), getAccount: vi.fn(),
  deriveVaultAuthority: vi.fn(), getAssociatedTokenAddress: vi.fn(),
  connection: null as unknown as Record<string, unknown>, wallet: null as unknown as Record<string, unknown>, config: null as unknown as Record<string, unknown>,
  inFlight: null as unknown,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: mocks.connection }), useWalletCompat: () => mocks.wallet }));
// jsdom's Uint8Array is not the Buffer realm web3.js' instruction encoder expects; the account metas are
// what this test reads, so the system instruction's data is irrelevant.
vi.mock("@solana/web3.js", async (orig) => {
  const a = await orig<typeof import("@solana/web3.js")>();
  return {
    ...a,
    SystemProgram: {
      ...a.SystemProgram,
      createAccount: (p: { fromPubkey: PublicKey; newAccountPubkey: PublicKey }) =>
        new a.TransactionInstruction({
          programId: a.SystemProgram.programId,
          keys: [{ pubkey: p.fromPubkey, isSigner: true, isWritable: true }, { pubkey: p.newAccountPubkey, isSigner: true, isWritable: true }],
          data: Buffer.alloc(0),
        }),
    },
  };
});
vi.mock("@/lib/tx", () => ({ sendTx: mocks.sendTx }));
vi.mock("@/lib/config", () => ({ getConfig: () => mocks.config, getNetwork: () => "mainnet" }));
vi.mock("@/lib/inFlightMarket", () => ({
  saveInFlightMarket: vi.fn(), updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(),
  // THIS browser's own unfinished launch (X): what the mount effect hydrates.
  loadLastInFlightMarket: vi.fn(() => mocks.inFlight),
}));
vi.mock("@solana/spl-token", async () => ({ ...(await vi.importActual<object>("@solana/spl-token")), getAccount: mocks.getAccount, getAssociatedTokenAddress: mocks.getAssociatedTokenAddress }));
vi.mock("@percolatorct/sdk", async () => ({ ...(await vi.importActual<object>("@percolatorct/sdk")), deriveVaultAuthority: mocks.deriveVaultAuthority }));

import { useCreateMarket } from "@/hooks/useCreateMarket";

const X = Keypair.generate(); // this browser's own unfinished launch
const Y = Keypair.generate().publicKey; // the slab the chain resume was verified for
const MINT = Keypair.generate().publicKey;

const params = {
  mint: MINT, initialPriceE6: 100_000_000n, lpCollateral: 1_000_000n, insuranceAmount: 100_000n, oracleFeed: "0".repeat(64), invert: false,
  tradingFeeBps: 10, initialMarginBps: 1_500, maxAccounts: 4_096, decimals: 6, symbol: "TEST", name: "Test Market", oracleMode: "admin" as const,
};

beforeEach(async () => {
  vi.clearAllMocks();
  const wallet = Keypair.generate();
  const programId = new PublicKey("69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9");
  mocks.config = { programId: programId.toBase58(), matcherProgramId: new PublicKey("4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT").toBase58(), programsBySlabTier: undefined };
  mocks.connection = { getAccountInfo: mocks.getAccountInfo, getProgramAccounts: mocks.getProgramAccounts, getMinimumBalanceForRentExemption: async () => 1 };
  mocks.wallet = { publicKey: wallet.publicKey, connected: true, connecting: false, signTransaction: vi.fn(async (t) => t), signAllTransactions: vi.fn(async (t) => t), signMessage: vi.fn(), disconnect: vi.fn() };
  mocks.inFlight = { slabAddress: X.publicKey.toBase58(), slabSecretKey: Array.from(X.secretKey), adminAddress: wallet.publicKey.toBase58(), collateralAta: "x", collateralMint: MINT.toBase58(), programId: programId.toBase58(), network: "devnet", createdAt: 1, lastStep: 2 };
  mocks.deriveVaultAuthority.mockReturnValue([new PublicKey(new Uint8Array(32).fill(23)), 255]);
  mocks.getAssociatedTokenAddress.mockResolvedValue(new PublicKey(new Uint8Array(32).fill(24)));
  mocks.getAccount.mockResolvedValue({ amount: 0n });
  const sdk = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  const slabData = Buffer.alloc(26_364);
  Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]).copy(slabData, 0);
  slabData.writeUInt16LE(sdk.V17_EXPECTED_VERSION, 8);
  mocks.getAccountInfo.mockResolvedValue({ data: slabData, executable: false, lamports: 1, owner: programId, rentEpoch: 0 });
  mocks.getProgramAccounts.mockResolvedValue([]); // no LP portfolio yet: step 2 builds TX A
  // record what the wallet is asked to sign, then stop the flow
  mocks.sendTx.mockImplementation(async () => { throw new Error("stop after the first transaction"); });
});

const keysOf = (ixs: TransactionInstruction[]) => ixs.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58()));

async function resume(fix: boolean) {
  const { result } = renderHook(() => useCreateMarket());
  // the mount effect has hydrated X from this browser's in-flight record
  await act(async () => {});
  act(() => {
    if (fix) result.current.restoreSlabAddress(Y.toBase58());
  });
  await act(async () => {
    await result.current.create(params, 2);
  });
  return result;
}

describe("a chain resume of Y never runs on this browser's own launch X", () => {
  it("every account lookup, derivation and transaction names Y, never X", async () => {
    await resume(true);
    // derivations and reads
    for (const call of mocks.deriveVaultAuthority.mock.calls) expect((call[1] as PublicKey).toBase58()).toBe(Y.toBase58());
    expect(mocks.deriveVaultAuthority).toHaveBeenCalled();
    const readKeys = mocks.getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58());
    expect(readKeys).toContain(Y.toBase58());
    expect(readKeys).not.toContain(X.publicKey.toBase58());
    // the LP scan filters on Y
    const filters = JSON.stringify(mocks.getProgramAccounts.mock.calls);
    expect(filters).toContain(Y.toBase58());
    expect(filters).not.toContain(X.publicKey.toBase58());
    // and the first transaction the wallet is asked to sign
    expect(mocks.sendTx).toHaveBeenCalled();
    for (const call of mocks.sendTx.mock.calls) {
      const ks = keysOf((call[0] as { instructions: TransactionInstruction[] }).instructions);
      expect(ks).toContain(Y.toBase58());
      expect(ks).not.toContain(X.publicKey.toBase58());
    }
  });

  it("CONTROL: without restoreSlabAddress the same resume runs on X (the bug this guards)", async () => {
    await resume(false);
    const readKeys = mocks.getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58());
    expect(readKeys).toContain(X.publicKey.toBase58());
  });

  it("a hydration that lands after restoreSlabAddress does not replace the resumed slab", async () => {
    const { result, rerender } = renderHook(() => useCreateMarket());
    act(() => result.current.restoreSlabAddress(Y.toBase58()));
    rerender();
    await act(async () => { await result.current.create(params, 2); });
    expect(mocks.getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58())).not.toContain(X.publicKey.toBase58());
  });
});
