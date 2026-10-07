/**
 * #3267 re-review: a chain-resume guard for slab Y must not survive into a local resume of slab X, and a
 * wallet switch in the middle of a running resume must abort the in-flight create() (its closure belongs to
 * the old wallet).
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { dropChainResume, useChainResumeWalletGuard } from "@/hooks/useChainResumeWalletGuard";

const Y = Keypair.generate().publicKey;
const X = Keypair.generate().publicKey;
const params = { mint: Keypair.generate().publicKey, initialPriceE6: 100_000_000n, lpCollateral: 1_000_000n, insuranceAmount: 100_000n, oracleFeed: "0".repeat(64), invert: false, tradingFeeBps: 10, initialMarginBps: 1_500, maxAccounts: 4_096, decimals: 6, symbol: "TEST", name: "Test Market", oracleMode: "admin" as const };

beforeEach(async () => {
  vi.clearAllMocks();
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
  mocks.getProgramAccounts.mockResolvedValue([]);
  mocks.sendTx.mockRejectedValue(new Error("stop"));
});

const readKeys = () => mocks.getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58());

describe("clearChainResume", () => {
  it("a local resume of X with no keypair never runs on the chain-resumed Y", async () => {
    const { result } = renderHook(() => useCreateMarket());
    act(() => result.current.restoreSlabAddress(Y.toBase58())); // chain resume of Y verified earlier
    act(() => result.current.clearChainResume()); // local resume of X starts (keypair not found)
    await act(async () => { await result.current.create(params, 2); });
    expect(readKeys()).not.toContain(Y.toBase58());
    expect(mocks.sendTx).not.toHaveBeenCalled();
    expect(result.current.state.error).toMatch(/slab keypair lost/i);
  });
  it("CONTROL: without it the same sequence runs on Y", async () => {
    const { result } = renderHook(() => useCreateMarket());
    act(() => result.current.restoreSlabAddress(Y.toBase58()));
    await act(async () => { await result.current.create(params, 2); });
    expect(readKeys()).toContain(Y.toBase58());
  });
  it("a local keypair for X restored after the clear is what runs", async () => {
    const xKp = Keypair.generate();
    const { result } = renderHook(() => useCreateMarket());
    act(() => result.current.restoreSlabAddress(Y.toBase58()));
    act(() => { result.current.clearChainResume(); result.current.restoreSlabKeypair(xKp, xKp.publicKey.toBase58()); });
    await act(async () => { await result.current.create(params, 2); });
    expect(readKeys()).toContain(xKp.publicKey.toBase58());
    expect(readKeys()).not.toContain(Y.toBase58());
    void X;
  });
});

describe("a wallet switch aborts the running resume", () => {
  it("the signal handed to the wallet-signing call is aborted by cancelInFlightLaunch, and the old closure stops", async () => {
    let signal: AbortSignal | undefined;
    mocks.sendTx.mockImplementation((o: { abortSignal?: AbortSignal }) => { signal = o.abortSignal; return new Promise(() => {}); });
    const { result } = renderHook(() => useCreateMarket());
    act(() => result.current.restoreSlabAddress(Y.toBase58()));
    void result.current.create(params, 2);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    act(() => result.current.cancelInFlightLaunch());
    expect(signal!.aborted).toBe(true);
  });

  it("dropChainResume aborts FIRST, then forgets, then resets", () => {
    const order: string[] = [];
    dropChainResume({ cancelInFlightLaunch: () => order.push("cancel"), forget: () => order.push("forget"), resetCreate: () => order.push("reset") });
    expect(order).toEqual(["cancel", "forget", "reset"]);
  });

  it("the guard fires on a wallet change only while a chain resume is active", () => {
    const drop = vi.fn();
    const { rerender } = renderHook(({ w, active }) => useChainResumeWalletGuard(w, active, drop), { initialProps: { w: "A" as string | null, active: false } });
    rerender({ w: "B", active: false });
    expect(drop).not.toHaveBeenCalled(); // no resume: nothing to drop
    rerender({ w: "B", active: true });
    expect(drop).not.toHaveBeenCalled(); // same wallet
    rerender({ w: "C", active: true });
    expect(drop).toHaveBeenCalledTimes(1);
    rerender({ w: null, active: true });
    expect(drop).toHaveBeenCalledTimes(2); // disconnect counts too
  });

  it("the wizard wires the guard to the real abort (source of the wiring only; behaviour is above)", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const src = fs.readFileSync(`${process.cwd()}/components/create/CreateMarketWizard.tsx`, "utf8");
    expect(src).toContain("useChainResumeWalletGuard(walletB58, !!chainResume");
    expect(src).toMatch(/dropChainResume\(\{\s+cancelInFlightLaunch,/);
    expect(src).toContain("clearChainResume?.();");
  });
});
