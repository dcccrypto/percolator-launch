/**
 * Follow-up to #3121 / #3122 (gusha625): useTransferPositionNft confirmed with blockheight-bound
 * confirmTransaction(), which throws TransactionExpiredBlockheightExceededError whenever its
 * signature subscription misses the landing, with no final status check; the resolver maps
 * "block height exceeded" to "Nothing was sent". A transfer that landed must resolve as success:
 * the hook confirms by polling the signature status (lib/tx.ts broadcastSignedTx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";

const OWNER = Keypair.generate().publicKey;
const NFT_MINT = Keypair.generate().publicKey;
const DEST = Keypair.generate().publicKey;
const SIG = "BxTwNncqseugcxgchPXUA9Gy7a7sCHBnoBQXW2E7XXnBvg6fRdNGNb41Bpjqn3En9rgD5eRyw77aGMuTrjk9wNz";

const h = vi.hoisted(() => ({ status: null as null | { err: unknown; confirmationStatus: string } }));
const toast = vi.fn();
const refresh = vi.fn();
const WALLET = { publicKey: OWNER, signTransaction: vi.fn(async (tx: unknown) => tx) };
const connection = {
  getAccountInfo: vi.fn(async (key: { equals: (o: unknown) => boolean }) =>
    key.equals(NFT_MINT)
      ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(0), lamports: 1, executable: false }
      : { owner: PERCOLATOR_NFT_PROGRAM_ID, data: Buffer.alloc(16), lamports: 1, executable: false },
  ),
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
vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => ({ nftMint: null }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ refresh }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast }) }));
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
  // PDA/ATA derivation hashes jsdom cross-realm Uint8Arrays and finds no viable nonce; not under test.
  const stub = () => [Keypair.generate().publicKey, 255] as [import("@solana/web3.js").PublicKey, number];
  class PublicKey extends real.PublicKey {
    static findProgramAddressSync = stub;
  }
  return { ...real, PublicKey, Transaction, ComputeBudgetProgram };
});
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<object>()), getAssociatedTokenAddressSync: () => Keypair.generate().publicKey }));

const { useTransferPositionNft } = await import("@/hooks/useTransferPositionNft");
const slab = Keypair.generate().publicKey.toBase58();

describe("Transfer position NFT: a transfer that landed is never reported as 'Nothing was sent'", () => {
  beforeEach(() => {
    toast.mockClear();
    refresh.mockClear();
    h.status = { err: null, confirmationStatus: "confirmed" };
  });

  it("a landed transfer resolves as success even when blockheight-bound confirmation would say expired", async () => {
    const { result } = renderHook(() => useTransferPositionNft(slab, { nftMint: NFT_MINT }));
    let sig: unknown;
    await act(async () => {
      sig = await result.current.transfer(DEST);
    });
    expect(sig).toBe(SIG);
    expect(result.current.error).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Position NFT sent to /), "success");
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/Nothing was sent/), "error");
    expect(refresh).toHaveBeenCalled();
  });

  it("a transfer that landed but failed on-chain is still an error", async () => {
    h.status = { err: { InstructionError: [3, { Custom: 1 }] }, confirmationStatus: "confirmed" };
    const { result } = renderHook(() => useTransferPositionNft(slab, { nftMint: NFT_MINT }));
    let sig: unknown;
    await act(async () => {
      sig = await result.current.transfer(DEST);
    });
    expect(sig).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Position NFT sent to /), "success");
  });
});
