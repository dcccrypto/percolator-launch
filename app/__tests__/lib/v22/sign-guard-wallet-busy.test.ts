// @vitest-environment node
/**
 * v2.2 QA 2026-10-15, create step 1 ("Create slab & initialize market" auto-cancelled in 0.1 s, 4001, no popup).
 *
 * Solflare 2.40.1 (read from the published extension): its background opens ONE confirm window at a time. A request
 * that arrives while that window is registered as open is never shown (`showPopup` only focuses the existing window,
 * which resolves at once) and is refused with `Cancelled`, which the background maps to 4001; the in-page script throws
 * `JsonRpcError(4001, "Cancelled")`. A person declining reads "Transaction cancelled" and takes longer.
 *
 * Also: the debug line's "not on devnet" list skips accounts a System createAccount in the same tx creates (the new slab).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import {
  __resetSignGuardForTest, accountsCreatedIn, formatSignEntry, guardSign, isWalletBusyRejection, noteBlockhash, signLog,
  WalletBusyError, WALLET_BUSY_MAX_MS,
} from "@/lib/v22/sign-guard";
import { WALLET_BUSY_COPY } from "@/lib/wallet-request-copy";
import { humanizeError, userFacingMessage } from "@/lib/errorMessages";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import { isWalletRejection } from "@/lib/privy-batch-sign";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const payer = Keypair.generate();

/** What Solflare's in-page script throws (inpage.js `class gs extends Error { code; name = "JsonRpcError" }`). */
class JsonRpcError extends Error {
  constructor(public code: number, message: string) { super(message); this.name = "JsonRpcError"; }
}
const busy = () => new JsonRpcError(4001, "Cancelled");

function tx(): Transaction {
  const t = new Transaction().add(new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.from([0]) }));
  t.recentBlockhash = BH;
  t.feePayer = payer.publicKey;
  return t;
}
const conn = { getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH), isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })) };

async function rejectAfter(err: unknown, afterMs: number): Promise<unknown> {
  let clock = 1_000_000;
  noteBlockhash(BH, "sendTx attempt 1 (+1 keypair signer)", conn, clock);
  return guardSign({
    txs: [tx()], via: "adapter signTransaction", connection: conn, chain: "solana:devnet", now: () => clock,
    sign: async () => { clock += afterMs; throw err; },
  }).catch((e) => e);
}

describe("create step 1: a wallet that refuses without showing the request (one of its windows is open)", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("JsonRpcError(4001, 'Cancelled') in 0.1 s -> WalletBusyError with the calm line; the log says why", async () => {
    const thrown = await rejectAfter(busy(), 100);
    expect(thrown).toBeInstanceOf(WalletBusyError);
    expect((thrown as Error).message).toBe(WALLET_BUSY_COPY);
    expect(userFacingMessage(thrown)).toBe(WALLET_BUSY_COPY);
    expect(humanizeError((thrown as Error).message)).toBe(WALLET_BUSY_COPY);
    const e = signLog()[0];
    expect(e.wallet).toBe("declined");
    expect(e.classified).toMatch(/^wallet busy/);
    expect(formatSignEntry(e)).toMatch(/raw JsonRpcError\/4001\/Cancelled/);
  });
  it("the same refusal wrapped by wallet-adapter (WalletSignTransactionError.error) is recognised too", async () => {
    const wrapped = Object.assign(new Error("Cancelled"), { name: "WalletSignTransactionError", error: { code: 4001, message: "Cancelled" } });
    expect(await rejectAfter(wrapped, 120)).toBeInstanceOf(WalletBusyError);
  });
  it("is not a decline: the launch's rejection check does not read it as the user cancelling", () => {
    expect(isWalletRejection(new WalletBusyError(busy()))).toBe(false);
  });
  it("parseMarketCreationError shows the line as is, with no step prefix", () => {
    expect(parseMarketCreationError(new WalletBusyError(busy()), { step: "create-market" as never, stepLabel: "Step 1 (Create slab & initialize market)" })).toBe(WALLET_BUSY_COPY);
  });

  describe("NEGATIVE CONTROLS: real declines keep their meaning", () => {
    it("a person's reject ('Transaction cancelled', 4001) answered quickly is NOT busy", async () => {
      expect(await rejectAfter(new JsonRpcError(4001, "Transaction cancelled"), 300)).not.toBeInstanceOf(WalletBusyError);
    });
    it("'Cancelled' after the window (the person closed the popup) is NOT busy", async () => {
      expect(await rejectAfter(busy(), WALLET_BUSY_MAX_MS + 500)).not.toBeInstanceOf(WalletBusyError);
    });
    it("a different code with the same text is NOT busy", () => {
      expect(isWalletBusyRejection(new JsonRpcError(-32603, "Cancelled"), 100)).toBe(false);
      expect(isWalletBusyRejection(busy(), 100)).toBe(true);
    });
  });

  it("records when another wallet request from this app was still open (overlap)", async () => {
    let release: () => void = () => {};
    noteBlockhash(BH, "t", conn);
    const first = guardSign({ txs: [tx()], via: "a", connection: conn, chain: "solana:devnet", sign: () => new Promise<number>((r) => { release = () => r(1); }) });
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(signLog().length).toBe(1));
    const second = guardSign({ txs: [tx()], via: "b", connection: conn, chain: "solana:devnet", sign: async () => { throw busy(); } }).catch((e) => e);
    expect(await second).toBeInstanceOf(WalletBusyError);
    const e2 = signLog().find((x) => x.via === "b")!;
    expect(e2.overlapping).toBe(true);
    expect(formatSignEntry(e2)).toMatch(/another wallet request from this app was still open/);
    release();
    await first;
    expect(signLog().find((x) => x.via === "a")!.overlapping).toBeUndefined();
  });
});

describe("debug line: an account this tx creates is not 'not on devnet'", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  const slab = Keypair.generate().publicKey;
  const stray = Keypair.generate().publicKey; // an on-curve key the cluster does not have and nothing creates
  function createTx(withCreate: boolean): Transaction {
    const t = new Transaction();
    if (withCreate) t.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: slab, lamports: 1, space: 4059, programId: WRAPPER }));
    t.add(new TransactionInstruction({ programId: WRAPPER, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: slab, isSigner: false, isWritable: true }, { pubkey: stray, isSigner: false, isWritable: false }], data: Buffer.from([0]) }));
    t.recentBlockhash = BH;
    t.feePayer = payer.publicKey;
    return t;
  }
  const c = {
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    isBlockhashValid: async () => ({ context: { slot: 1 }, value: true }),
    // the payer exists; the new slab and the stray key do not
    getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map((k) => (k.equals(payer.publicKey) || k.equals(SystemProgram.programId) ? ({} as never) : null)),
  };

  it("the slab a createAccount in the same tx creates is listed apart, not as a suspect", async () => {
    noteBlockhash(BH, "sendTx attempt 1 (+1 keypair signer)", c as never);
    await guardSign({ txs: [createTx(true)], via: "adapter signTransaction", connection: c as never, chain: "solana:devnet", sign: async () => 1 });
    const e = signLog()[0];
    expect(accountsCreatedIn(createTx(true)).has(slab.toBase58())).toBe(true);
    expect(e.absentOnDevnet).toEqual([`r:${stray.toBase58()}`]);
    expect(e.absentCreated).toEqual([`w:${slab.toBase58()}`]);
    const line = formatSignEntry(e);
    expect(line).not.toContain(`w:${slab.toBase58()}`);
    expect(line).toContain("(+1 new account this tx creates)");
  });
  it("NEGATIVE CONTROL: without the createAccount the same absent slab IS a suspect", async () => {
    noteBlockhash(BH, "t", c as never);
    await guardSign({ txs: [createTx(false)], via: "x", connection: c as never, chain: "solana:devnet", sign: async () => 1 });
    const e = signLog()[0];
    expect(e.absentOnDevnet).toContain(`w:${slab.toBase58()}`);
    expect(e.absentCreated).toBeUndefined();
  });
  it("createAccountWithSeed targets count as created too; a transfer does not", () => {
    const base = Keypair.generate().publicKey;
    const derived = Keypair.generate().publicKey;
    const t = new Transaction()
      .add(SystemProgram.createAccountWithSeed({ fromPubkey: payer.publicKey, newAccountPubkey: derived, basePubkey: base, seed: "s", lamports: 1, space: 8, programId: WRAPPER }))
      .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stray, lamports: 1 }));
    expect([...accountsCreatedIn(t)]).toEqual([derived.toBase58()]);
  });
});
