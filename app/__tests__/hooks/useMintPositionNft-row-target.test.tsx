/**
 * S4: "Wrap as NFT" re-discovered the wallet's portfolio with getProgramAccounts and took the first
 * result in RPC order, while the row and the wrap sheet show the lowest-pubkey one (pickOwnerPortfolio).
 * A wallet can own two portfolios on a market (wrap, trade again, unwrap), so the wrap could escrow
 * a position and collateral the user didn't pick, or refuse with "No active position" while the row
 * shows one. The hook now wraps exactly the account the row names, through the #3301 target gate.
 * The real verifyPortfolioTarget runs; the account bytes decode per account below.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { act, renderHook } from "@testing-library/react";
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";

const WRAPPER = Keypair.generate().publicKey;
const OWNER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const SHOWN = Keypair.generate().publicKey; // the row's account
const OTHER = Keypair.generate().publicKey; // the RPC-first one
const SIG = "BxTwNncqseugcxgchPXUA9Gy7a7sCHBnoBQXW2E7XXnBvg6fRdNGNb41Bpjqn3En9rgD5eRyw77aGMuTrjk9wNz";
const PDA = () => [Keypair.generate().publicKey, 255] as const;

type Pf = { owner: PublicKey; marketGroupId: PublicKey; legs: Array<{ active: boolean; marketId: bigint }> };
const h = vi.hoisted(() => ({ byTag: new Map<number, unknown>(), infos: new Map<string, unknown>(), signed: [] as unknown[] }));
const toast = vi.fn();
const WALLET = { publicKey: OWNER, signTransaction: vi.fn(async (tx: Transaction) => { h.signed.push(tx); return tx; }) };
const connection = {
  getProgramAccounts: vi.fn(async () => [{ pubkey: OTHER, account: { data: Buffer.from([2]) } }, { pubkey: SHOWN, account: { data: Buffer.from([1]) } }]),
  getAccountInfo: vi.fn(async (pk: PublicKey) => h.infos.get(pk.toBase58()) ?? null),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
  simulateTransaction: vi.fn(async () => ({ value: { err: null, logs: [] } })),
  sendRawTransaction: vi.fn(async () => SIG),
  getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] })),
};

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => ({ connection }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ programId: WRAPPER, raw: new Uint8Array(8), refresh: vi.fn() }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
// Shape checks (length/kind, LP bit) pass; ownership and market are decided by the decoded fields.
vi.mock("@/lib/portfolio-account", () => ({ isPortfolioAccount: () => true }));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<object>()),
  isV17Account: () => true,
  parsePortfolioV17: (d: Uint8Array) => h.byTag.get(d[0]),
  deriveNftPda: PDA,
  deriveMintAuthority: PDA,
  deriveExtraAccountMetas: PDA,
  deriveNftRegistry: PDA,
  encodeNftMint: () => new Uint8Array([0]),
}));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<object>()), getAssociatedTokenAddressSync: () => PDA()[0] }));
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  class Transaction extends real.Transaction {
    partialSign() {}
    serialize() { return Buffer.alloc(1); }
  }
  const ix = () => new real.TransactionInstruction({ programId: real.ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(0) });
  const ComputeBudgetProgram = { programId: real.ComputeBudgetProgram.programId, requestHeapFrame: ix, setComputeUnitLimit: ix, setComputeUnitPrice: ix };
  return { ...real, Transaction, ComputeBudgetProgram };
});

const { useMintPositionNft } = await import("@/hooks/useMintPositionNft");
const { TARGET_COPY } = await import("@/lib/portfolio-target");
const { PERCOLATOR_NFT_PROGRAM_ID } = await import("@/lib/nft-program");

const account = (tag: number, pf: Pf) => {
  h.byTag.set(tag, pf);
  return { owner: WRAPPER, data: Buffer.from([tag]) };
};
const active = [{ active: true, marketId: 0n }];

async function wrap(pk: PublicKey) {
  const { result } = renderHook(() => useMintPositionNft(MARKET.toBase58()));
  let sig: unknown;
  await act(async () => { sig = await result.current.mint(pk); });
  return { sig, error: result.current.error };
}
const mintIx = () => (h.signed[0] as Transaction).instructions.find((ix) => ix.programId.equals(PERCOLATOR_NFT_PROGRAM_ID))!;

// v2.1 account fixtures: decoded by the v2.1 parsers (v2.2 flag off), the convention from 02e50adc.
beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => __setDevnetV22ForTest(null));

describe("Wrap as NFT wraps exactly the row's account", () => {
  beforeEach(() => {
    h.byTag.clear();
    h.infos.clear();
    h.signed = [];
    vi.clearAllMocks();
  });

  it("both accounts active, the other one first in RPC order: the row's account is wrapped, no rediscovery", async () => {
    h.infos.set(SHOWN.toBase58(), account(1, { owner: OWNER, marketGroupId: MARKET, legs: active }));
    h.infos.set(OTHER.toBase58(), account(2, { owner: OWNER, marketGroupId: MARKET, legs: active }));
    const { sig } = await wrap(SHOWN);
    expect(sig).toBe(SIG);
    expect(connection.getProgramAccounts).not.toHaveBeenCalled();
    expect(mintIx().keys[4].pubkey.equals(SHOWN)).toBe(true);
  });

  it("the other account is flat and first in RPC order: still wraps the row's open position", async () => {
    h.infos.set(SHOWN.toBase58(), account(1, { owner: OWNER, marketGroupId: MARKET, legs: active }));
    h.infos.set(OTHER.toBase58(), account(2, { owner: OWNER, marketGroupId: MARKET, legs: [] }));
    const { sig, error } = await wrap(SHOWN);
    expect(error).toBeNull();
    expect(sig).toBe(SIG);
    expect(mintIx().keys[4].pubkey.equals(SHOWN)).toBe(true);
  });

  it.each([
    ["owned by another wallet (e.g. already escrowed)", { owner: Keypair.generate().publicKey, marketGroupId: MARKET, legs: active }],
    ["on another market", { owner: OWNER, marketGroupId: Keypair.generate().publicKey, legs: active }],
  ])("a named account %s is refused before signing", async (_label, pf) => {
    h.infos.set(SHOWN.toBase58(), account(1, pf as Pf));
    const { sig, error } = await wrap(SHOWN);
    expect(sig).toBeUndefined();
    expect(error).toBe(TARGET_COPY.unmatched);
    expect(WALLET.signTransaction).not.toHaveBeenCalled();
  });

  it("a flat row account is refused before signing (as before)", async () => {
    h.infos.set(SHOWN.toBase58(), account(1, { owner: OWNER, marketGroupId: MARKET, legs: [] }));
    const { error } = await wrap(SHOWN);
    expect(error).not.toBeNull();
    expect(WALLET.signTransaction).not.toHaveBeenCalled();
  });
});
