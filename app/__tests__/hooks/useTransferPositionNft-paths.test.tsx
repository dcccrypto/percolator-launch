/**
 * Coverage for useTransferPositionNft: guards (wallet/NFT/signing/self-transfer), preflight failures
 * (mint missing / wrong owner / hook metadata missing, wrong owner, corrupt, unsupported), simulation
 * failure, wallet rejection, send error, confirmation timeout vs landed, and state reset after an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { CONFIRMATION_POLL } from "@/lib/tx";

const OWNER = Keypair.generate().publicKey;
const NFT_MINT = Keypair.generate().publicKey;
const SCANNED_MINT = Keypair.generate().publicKey;
const DEST = Keypair.generate().publicKey;
const SIG = "BxTwNncqseugcxgchPXUA9Gy7a7sCHBnoBQXW2E7XXnBvg6fRdNGNb41Bpjqn3En9rgD5eRyw77aGMuTrjk9wNz";
const EXTRA_KEY = Keypair.generate().publicKey;

/** A valid ExtraAccountMetaList with one FixedPubkey entry. */
function validMetaList(): Buffer {
  const b = Buffer.alloc(16 + 35);
  b.writeUInt32LE(1, 12);
  b[16] = 0;
  Buffer.from(EXTRA_KEY.toBytes()).copy(b, 17);
  b[16 + 33] = 0;
  b[16 + 34] = 1;
  return b;
}

type Info = { owner: PublicKey; data: Buffer; lamports: number; executable: boolean } | null;
const h = vi.hoisted(() => ({
  wallet: null as null | { publicKey: unknown; signTransaction: unknown },
  scanned: null as unknown,
  mintInfo: null as unknown,
  metaInfo: null as unknown,
  sim: null as unknown,
  sendImpl: null as null | (() => Promise<string>),
  signImpl: null as null | ((tx: unknown) => Promise<unknown>),
  status: null as unknown,
}));
const toast = vi.fn();
const refresh = vi.fn();
const connection = {
  getAccountInfo: vi.fn(async (key: { equals: (o: unknown) => boolean }) =>
    key.equals(NFT_MINT) || key.equals(SCANNED_MINT) ? h.mintInfo : h.metaInfo,
  ),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
  simulateTransaction: vi.fn(async () => h.sim),
  sendRawTransaction: vi.fn(async () => h.sendImpl!()),
  getSignatureStatuses: vi.fn(async () => ({ value: [h.status] })),
};

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => h.wallet, useConnectionCompat: () => ({ connection }) }));
vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => h.scanned }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ refresh }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  class Transaction extends real.Transaction {
    partialSign() {}
    serialize() {
      return Buffer.alloc(1);
    }
  }
  const ix = () => new real.TransactionInstruction({ programId: real.ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(0) });
  const ComputeBudgetProgram = { programId: real.ComputeBudgetProgram.programId, requestHeapFrame: ix, setComputeUnitLimit: ix, setComputeUnitPrice: ix };
  const stub = () => [Keypair.generate().publicKey, 255] as [import("@solana/web3.js").PublicKey, number];
  class PublicKey extends real.PublicKey {
    static findProgramAddressSync = stub;
  }
  return { ...real, PublicKey, Transaction, ComputeBudgetProgram };
});
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<object>()), getAssociatedTokenAddressSync: () => Keypair.generate().publicKey }));

const { useTransferPositionNft } = await import("@/hooks/useTransferPositionNft");
const slab = Keypair.generate().publicKey.toBase58();

const info = (owner: PublicKey, data: Buffer = Buffer.alloc(0)): Info => ({ owner, data, lamports: 1, executable: false });

async function run(dest: PublicKey = DEST, override: boolean = true) {
  const hook = renderHook(() => useTransferPositionNft(slab, override ? { nftMint: NFT_MINT } : undefined));
  let sig: unknown = "unset";
  await act(async () => {
    sig = await hook.result.current.transfer(dest);
  });
  return { hook, sig };
}

describe("useTransferPositionNft paths", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    toast.mockClear();
    refresh.mockClear();
    connection.sendRawTransaction.mockClear();
    connection.simulateTransaction.mockClear();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    h.wallet = { publicKey: OWNER, signTransaction: vi.fn(async (tx: unknown) => (h.signImpl ? h.signImpl(tx) : tx)) };
    h.scanned = { nftMint: null };
    h.mintInfo = info(TOKEN_2022_PROGRAM_ID);
    h.metaInfo = info(PERCOLATOR_NFT_PROGRAM_ID, validMetaList());
    h.sim = { value: { err: null, logs: [] } };
    h.sendImpl = async () => SIG;
    h.signImpl = null;
    h.status = { err: null, confirmationStatus: "confirmed" };
  });
  afterEach(() => {
    errSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("happy path sends, refreshes, and returns the signature", async () => {
    const { hook, sig } = await run();
    expect(sig).toBe(SIG);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    expect(refresh).toHaveBeenCalled();
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("falls back to the scanned NFT mint when no override is given", async () => {
    h.scanned = { nftMint: SCANNED_MINT };
    const { sig } = await run(DEST, false);
    expect(sig).toBe(SIG);
  });

  it("refuses without a wallet or without an NFT, sending nothing", async () => {
    h.wallet = { publicKey: null, signTransaction: vi.fn() };
    let r = await run();
    expect(r.sig).toBeNull();
    expect(r.hook.result.current.error).toBe("Wallet not connected or NFT not minted");

    h.wallet = { publicKey: OWNER, signTransaction: vi.fn() };
    r = await run(DEST, false); // no override, scan found nothing
    expect(r.sig).toBeNull();
    expect(r.hook.result.current.error).toBe("Wallet not connected or NFT not minted");
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("refuses a wallet that cannot sign", async () => {
    h.wallet = { publicKey: OWNER, signTransaction: undefined };
    const { sig, hook } = await run();
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBe("Wallet does not support signing");
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the recipient is the owner (no tx built)", async () => {
    const { sig, hook } = await run(OWNER);
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBe("Destination must be a different wallet");
    expect(hook.result.current.loading).toBe(false);
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["mint missing on RPC", () => { h.mintInfo = null; }, /was not found on the connected RPC/],
    ["mint not Token-2022", () => { h.mintInfo = info(Keypair.generate().publicKey); }, /not Token-2022/],
    ["hook metadata PDA missing", () => { h.metaInfo = null; }, /RepairExtraMetas/],
    ["hook metadata wrong owner", () => { h.metaInfo = info(Keypair.generate().publicKey, validMetaList()); }, /expected /],
    ["hook metadata too short", () => { h.metaInfo = info(PERCOLATOR_NFT_PROGRAM_ID, Buffer.alloc(4)); }, /too short/],
    ["hook metadata truncated", () => { const b = Buffer.alloc(16); b.writeUInt32LE(2, 12); h.metaInfo = info(PERCOLATOR_NFT_PROGRAM_ID, b); }, /truncated/],
    ["hook metadata unsupported entry", () => { const b = validMetaList(); b[16] = 1; h.metaInfo = info(PERCOLATOR_NFT_PROGRAM_ID, b); }, /unsupported discriminator/],
  ])("preflight: %s -> error, nothing sent", async (_n, setup, re) => {
    setup();
    const { sig, hook } = await run();
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0].slice(-1)[0])).toMatch(re);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a failed simulation surfaces an error and never asks the wallet to sign", async () => {
    h.sim = { value: { err: { InstructionError: [4, { Custom: 7 }] }, logs: ["Program log: below maintenance margin", "noise"] } };
    const { sig, hook } = await run();
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBeTruthy();
    expect((h.wallet as { signTransaction: ReturnType<typeof vi.fn> }).signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a simulation failure with no logs still errors", async () => {
    h.sim = { value: { err: "AccountNotFound" } };
    const { sig } = await run();
    expect(sig).toBeNull();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a wallet rejection is silent: no error, no toast, nothing sent, loading cleared", async () => {
    h.signImpl = async () => {
      throw new Error("User rejected the request.");
    };
    const { sig, hook } = await run();
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a send error (RPC refuses) is reported with a toast and nothing is refreshed", async () => {
    h.sendImpl = async () => {
      throw new Error("blockhash not found");
    };
    const { sig, hook } = await run();
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(hook.result.current.error, "error");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an error with an empty message names the stage it failed in", async () => {
    h.signImpl = async () => {
      throw new Error("");
    };
    const { sig, hook } = await run();
    expect(sig).toBeNull();
    expect(hook.result.current.error).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("a non-Error throw is stringified, and null-ish throws fall back to the stage message", async () => {
    h.signImpl = async () => {
      throw "plain string failure";
    };
    let r = await run();
    expect(r.sig).toBeNull();
    expect(r.hook.result.current.error).toBeTruthy();

    h.signImpl = async () => {
      throw null;
    };
    r = await run();
    expect(r.sig).toBeNull();
    expect(r.hook.result.current.error).toBeTruthy();
  });

  it("a confirmation timeout is an error (not success): no refresh, no success toast", async () => {
    const prev = CONFIRMATION_POLL.maxMs;
    CONFIRMATION_POLL.maxMs = 0; // the poll loop never runs -> "Confirmation timeout"
    try {
      const { sig, hook } = await run();
      expect(sig).toBeNull();
      expect(hook.result.current.error).toBeTruthy();
      expect(refresh).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Position NFT sent to /), "success");
    } finally {
      CONFIRMATION_POLL.maxMs = prev;
    }
  });

  it("a tx that lands after a not-yet-visible poll resolves as success", async () => {
    let calls = 0;
    connection.getSignatureStatuses.mockImplementation(async () => ({ value: [calls++ === 0 ? null : h.status] }));
    try {
      const { sig, hook } = await run();
      expect(sig).toBe(SIG);
      expect(hook.result.current.error).toBeNull();
      expect(refresh).toHaveBeenCalled();
    } finally {
      connection.getSignatureStatuses.mockImplementation(async () => ({ value: [h.status] }));
    }
  });

  it("state resets after an error: the next attempt clears the error and succeeds", async () => {
    h.sendImpl = async () => {
      throw new Error("blockhash not found");
    };
    const hook = renderHook(() => useTransferPositionNft(slab, { nftMint: NFT_MINT }));
    await act(async () => {
      await hook.result.current.transfer(DEST);
    });
    expect(hook.result.current.error).toBeTruthy();

    h.sendImpl = async () => SIG;
    let sig: unknown;
    await act(async () => {
      sig = await hook.result.current.transfer(DEST);
    });
    expect(sig).toBe(SIG);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it("a rejection after an earlier error also clears the stale error", async () => {
    h.sendImpl = async () => {
      throw new Error("blockhash not found");
    };
    const hook = renderHook(() => useTransferPositionNft(slab, { nftMint: NFT_MINT }));
    await act(async () => {
      await hook.result.current.transfer(DEST);
    });
    expect(hook.result.current.error).toBeTruthy();

    h.signImpl = async () => {
      throw new Error("User rejected the request.");
    };
    await act(async () => {
      await hook.result.current.transfer(DEST);
    });
    expect(hook.result.current.error).toBeNull();
  });
});
