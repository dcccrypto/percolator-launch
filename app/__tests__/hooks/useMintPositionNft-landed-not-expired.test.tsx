/**
 * Wrap as NFT showed "The network was slow. Nothing was sent." for a MintPositionNft that had
 * landed (devnet sig BxTwNncq...wNz, 2026-10-05). The hook confirmed with blockheight-bound
 * confirmTransaction(), which throws TransactionExpiredBlockheightExceededError whenever its
 * signature subscription misses the landing, with no final status check; the resolver maps
 * "block height exceeded" to "Nothing was sent". The hook must confirm by polling the
 * signature status (lib/tx.ts broadcastSignedTx), like sendTx and the batch paths do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";

const WRAPPER = Keypair.generate().publicKey;
const PDA = () => [Keypair.generate().publicKey, 255] as const;
const OWNER = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const SIG = "BxTwNncqseugcxgchPXUA9Gy7a7sCHBnoBQXW2E7XXnBvg6fRdNGNb41Bpjqn3En9rgD5eRyw77aGMuTrjk9wNz";

const h = vi.hoisted(() => ({ status: null as null | { err: unknown; confirmationStatus: string } }));
const toast = vi.fn();
const refresh = vi.fn();
const WALLET = {
  publicKey: OWNER,
  signTransaction: vi.fn(async (tx: unknown) => tx),
};
const connection = {
  getProgramAccounts: vi.fn(async () => [{ pubkey: PORTFOLIO, account: { data: Buffer.alloc(16) } }]),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
  simulateTransaction: vi.fn(async () => ({ value: { err: null, logs: [] } })),
  sendRawTransaction: vi.fn(async () => SIG),
  // What web3.js does when its subscription misses a tx that landed: the expiry race wins.
  confirmTransaction: vi.fn(async () => {
    throw new TransactionExpiredBlockheightExceededError(SIG);
  }),
  getSignatureStatuses: vi.fn(async () => ({ value: [h.status] })),
};

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => ({ connection }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ programId: WRAPPER, raw: new Uint8Array(8), refresh }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/userAccountScan", () => ({ isLpPortfolio: () => false }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<object>()),
  isV17Account: () => true,
  parsePortfolioV17: () => ({ owner: OWNER, legs: [{ active: true, marketId: 0n }] }),
  deriveNftPda: PDA,
  deriveMintAuthority: PDA,
  deriveExtraAccountMetas: PDA,
  deriveNftRegistry: PDA,
  encodeNftMint: () => new Uint8Array([0]),
}));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<object>()), getAssociatedTokenAddressSync: () => PDA()[0] }));
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  // Signing/serialising a real tx needs real signatures; the hook only needs the bytes to hand over.
  class Transaction extends real.Transaction {
    partialSign() {}
    serialize() {
      return Buffer.alloc(1);
    }
  }
  // buffer-layout's encoders reject jsdom's cross-realm Uint8Array; the budget ixs are not under test.
  const ix = () => new real.TransactionInstruction({ programId: real.ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(0) });
  const ComputeBudgetProgram = { programId: real.ComputeBudgetProgram.programId, requestHeapFrame: ix, setComputeUnitLimit: ix, setComputeUnitPrice: ix };
  return { ...real, Transaction, ComputeBudgetProgram };
});

const { useMintPositionNft } = await import("@/hooks/useMintPositionNft");
const slab = Keypair.generate().publicKey.toBase58();

describe("Wrap as NFT: a mint that landed is never reported as 'Nothing was sent'", () => {
  beforeEach(() => {
    toast.mockClear();
    refresh.mockClear();
    h.status = { err: null, confirmationStatus: "confirmed" };
  });

  it("a landed mint resolves as success even when blockheight-bound confirmation would say expired", async () => {
    const { result } = renderHook(() => useMintPositionNft(slab));
    let sig: unknown;
    await act(async () => {
      sig = await result.current.mint();
    });
    expect(sig).toBe(SIG);
    expect(result.current.error).toBeNull();
    expect(toast).toHaveBeenCalledWith("Position NFT minted!", "success");
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/Nothing was sent/), "error");
    expect(refresh).toHaveBeenCalled();
  });

  it("a mint that landed but failed on-chain is still an error (#2994 kept)", async () => {
    h.status = { err: { InstructionError: [3, { Custom: 1 }] }, confirmationStatus: "confirmed" };
    const { result } = renderHook(() => useMintPositionNft(slab));
    let sig: unknown;
    await act(async () => {
      sig = await result.current.mint();
    });
    expect(sig).toBeUndefined();
    expect(result.current.error).not.toBeNull();
    expect(toast).not.toHaveBeenCalledWith("Position NFT minted!", "success");
  });
});
