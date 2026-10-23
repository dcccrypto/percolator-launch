// @vitest-environment node
/**
 * v2.2 QA NB-2 (reopened in retest 5): one order showed Solflare's "Network mismatch". Every wallet signature now
 * passes lib/v22/sign-guard.ts (devnet genesis + blockhash origin, logged with the path that built the tx) and
 * Wallet Standard wallets are told `solana:devnet` (lib/v22/standard-sign.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import {
  __resetSignGuardForTest, formatSignEntry, guardSign, lastSignProblem, noteBlockhash, SignGuardError, signLog, txShape, STALE_BLOCKHASH_MS,
} from "@/lib/v22/sign-guard";
import { standardDevnetSigner } from "@/lib/v22/standard-sign";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const payer = Keypair.generate();
const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const conn = (genesis: string, valid: boolean | Error = true) => ({
  getGenesisHash: vi.fn(async () => genesis),
  isBlockhashValid: vi.fn(async () => { if (valid instanceof Error) throw valid; return { context: { slot: 1 }, value: valid }; }),
});
function tradeTx(blockhash = BH): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
  tx.add(new TransactionInstruction({ programId: WRAPPER, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([10, 1, 2]) }));
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  return tx;
}

describe("NB-2 sign guard", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("names what was built: program + instruction tag", () => {
    expect(txShape(tradeTx(), WRAPPER.toBase58())).toBe("cb,w:10");
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
    expect(txShape(t)).toBe("sys");
  });

  it("devnet connection + tagged fresh blockhash: the wallet is asked, the request is logged with its path", async () => {
    const c = conn(DEVNET_GENESIS_HASH);
    noteBlockhash(BH, "sendTx attempt 1", c, 1_000);
    const sign = vi.fn(async () => "signed");
    await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", wrapperProgramId: WRAPPER.toBase58(), sign, now: () => 3_500 })).resolves.toBe("signed");
    expect(sign).toHaveBeenCalledTimes(1);
    // Round f: a tagged blockhash is also checked at `confirmed` right before the wallet opens, and the log says so.
    expect(c.isBlockhashValid).toHaveBeenCalledTimes(1);
    expect(signLog()).toHaveLength(1);
    expect(signLog()[0]).toMatchObject({ verdict: "ok", wallet: "signed", path: "sendTx attempt 1", blockhashAgeMs: 2_500, shape: "cb,w:10", chain: "solana:devnet" });
    expect(lastSignProblem()).toBeNull();
  });

  it("NEGATIVE: a mainnet connection is refused before the wallet opens, and the line names the path", async () => {
    const c = conn(MAINNET_GENESIS);
    noteBlockhash(BH, "sendTx attempt 1", c, 1_000);
    const sign = vi.fn(async () => "signed");
    const p = guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign, now: () => 2_000 });
    await expect(p).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    const e = lastSignProblem()!;
    expect(e).toMatchObject({ verdict: "REFUSED-wrong-cluster", wallet: "not-asked", path: "sendTx attempt 1" });
    expect(formatSignEntry(e)).toContain("built by sendTx attempt 1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[v22 sign-guard] REFUSED-wrong-cluster"));
  });

  it("NEGATIVE: a blockhash fetched from a mainnet connection is refused even when the app connection is devnet", async () => {
    const app = conn(DEVNET_GENESIS_HASH);
    const stale = conn(MAINNET_GENESIS);
    noteBlockhash(BH, "stale Connection kept across a reconnect", stale, 1_000);
    const sign = vi.fn(async () => "signed");
    await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: app, chain: "solana:devnet", sign, now: () => 2_000 })).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()!.path).toBe("stale Connection kept across a reconnect");
  });

  it("NEGATIVE: an untagged blockhash that devnet does not know is refused", async () => {
    const c = conn(DEVNET_GENESIS_HASH, false);
    const sign = vi.fn(async () => "signed");
    await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign })).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()).toMatchObject({ verdict: "REFUSED-blockhash-not-on-devnet", blockhashAgeMs: null });
    expect(lastSignProblem()!.path).toContain("UNTAGGED");
  });

  it("an untagged blockhash that devnet knows is signed but reported; an RPC failure proves nothing and does not block", async () => {
    for (const valid of [true, new Error("rpc down")] as const) {
      __resetSignGuardForTest();
      const c = conn(DEVNET_GENESIS_HASH, valid);
      const sign = vi.fn(async () => "signed");
      await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign })).resolves.toBe("signed");
      expect(lastSignProblem()).toMatchObject({ verdict: "untagged-blockhash", wallet: "signed" });
    }
  });

  it("a blockhash older than 30 s when the wallet opens is reported as stale (and still signed)", async () => {
    const c = conn(DEVNET_GENESIS_HASH);
    noteBlockhash(BH, "sendTx attempt 1", c, 0);
    const sign = vi.fn(async () => "signed");
    await guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign, now: () => STALE_BLOCKHASH_MS + 1 });
    expect(lastSignProblem()).toMatchObject({ verdict: "stale-blockhash", wallet: "signed" });
  });

  it("a request the wallet declines (how a wallet-side 'Network mismatch' reaches the app) shows the path that built it", async () => {
    const c = conn(DEVNET_GENESIS_HASH);
    noteBlockhash(BH, "sendTx attempt 2", c, 1_000);
    const err = new Error("User rejected the request.");
    await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign: async () => { throw err; }, now: () => 1_500 })).rejects.toBe(err);
    expect(lastSignProblem()).toMatchObject({ verdict: "ok", wallet: "declined", path: "sendTx attempt 2" });
    expect(lastSignProblem()!.walletError).toContain("User rejected");
  });

  it("signAllTransactions: every transaction is checked; one bad one refuses the whole batch", async () => {
    const c = conn(DEVNET_GENESIS_HASH, false);
    noteBlockhash(BH, "useTrade leg groups", c, 1_000);
    const sign = vi.fn(async () => []);
    await expect(guardSign({ txs: [tradeTx(), tradeTx("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi")], via: "adapter signAllTransactions", connection: c, chain: "solana:devnet", sign, now: () => 1_200 })).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(signLog().map((e) => [e.via, e.verdict, e.wallet])).toEqual([
      ["adapter signAllTransactions[1/2]", "stale-blockhash", "not-asked"],
      ["adapter signAllTransactions[2/2]", "REFUSED-blockhash-not-on-devnet", "not-asked"],
    ]);
  });

  it("an RPC that never answers proves nothing and does not hold the signature up", async () => {
    const hang = { getGenesisHash: () => new Promise<string>(() => {}), isBlockhashValid: () => new Promise<never>(() => {}) };
    const sign = vi.fn(async () => "signed");
    await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: hang, chain: "solana:devnet", sign, rpcTimeoutMs: 20 })).resolves.toBe("signed");
    expect(lastSignProblem()).toMatchObject({ verdict: "untagged-blockhash", wallet: "signed" });
  });

  it("a transaction object the guard cannot read still gets signed (instrumentation never breaks a signature)", async () => {
    const c = conn(DEVNET_GENESIS_HASH);
    noteBlockhash(BH, "sendTx attempt 1", c);
    const odd = { recentBlockhash: BH } as unknown as Transaction;
    await expect(guardSign({ txs: [odd], via: "x", connection: c, chain: "none", sign: async () => 1 })).resolves.toBe(1);
    expect(txShape({ instructions: [{ programId: null, data: null }] } as never)).toBe("?");
  });

  it("RT5b: accounts the devnet connection does not have are recorded and shown in the line; never a refusal by themselves", async () => {
    const tx = tradeTx();
    const c = { ...conn(DEVNET_GENESIS_HASH), getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map(() => null)) };
    noteBlockhash(BH, "sendTx attempt 1", c);
    await expect(guardSign({ txs: [tx], via: "adapter signTransaction", connection: c as never, chain: "solana:devnet", sign: async () => { throw new Error("User rejected the request."); } })).rejects.toThrow(/rejected/);
    const e = lastSignProblem()!;
    expect(e.absentOnDevnet).toEqual([`w:${payer.publicKey.toBase58()}`]);
    expect(formatSignEntry(e)).toContain(`not on devnet: w:${payer.publicKey.toBase58()}`);
    __resetSignGuardForTest();
    const all = { ...conn(DEVNET_GENESIS_HASH), getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map(() => ({}) as never)) };
    noteBlockhash(BH, "sendTx attempt 1", all);
    await guardSign({ txs: [tradeTx()], via: "x", connection: all as never, chain: "solana:devnet", sign: async () => 1 });
    expect(signLog()[0].absentOnDevnet).toEqual([]);
    expect(formatSignEntry(signLog()[0])).toContain("all accounts on devnet");
    expect(lastSignProblem()).toBeNull();
  });

  it("flag off: a pass-through (no RPC, no log)", async () => {
    __setDevnetV22ForTest(false);
    const c = conn(MAINNET_GENESIS, false);
    await expect(guardSign({ txs: [tradeTx()], via: "x", connection: c, chain: "none", sign: async () => 7 })).resolves.toBe(7);
    expect(c.getGenesisHash).not.toHaveBeenCalled();
    expect(signLog()).toHaveLength(0);
  });
});

describe("NB-2: Wallet Standard wallets are told the chain", () => {
  const account = (chains: string[]) => ({ address: payer.publicKey.toBase58(), chains, features: ["solana:signTransaction"] });
  const adapter = (chains: string[], signTransaction: (...i: { chain: string; transaction: Uint8Array }[]) => Promise<{ signedTransaction: Uint8Array }[]>) => ({
    standard: true,
    wallet: { accounts: [account(chains)], features: { "solana:signTransaction": { signTransaction } } },
  });

  it("every input carries chain solana:devnet and the signed bytes come back as transactions", async () => {
    const seen: string[] = [];
    const a = adapter(["solana:mainnet", "solana:devnet"], async (...inputs) => inputs.map((i) => {
      seen.push(i.chain);
      const t = Transaction.from(i.transaction);
      t.partialSign(payer);
      return { signedTransaction: new Uint8Array(t.serialize()) };
    }));
    const signer = standardDevnetSigner(a, payer.publicKey)!;
    expect(signer).not.toBeNull();
    const out = await signer([tradeTx(), tradeTx()]);
    expect(seen).toEqual(["solana:devnet", "solana:devnet"]);
    expect(out).toHaveLength(2);
    expect(out[0].verifySignatures()).toBe(true);
    expect(out[0].recentBlockhash).toBe(BH);
  });

  it("falls back (null) for a legacy adapter, a wallet whose account does not list devnet, or another account", () => {
    const sign = async () => [];
    expect(standardDevnetSigner({ signTransaction: sign }, payer.publicKey)).toBeNull();
    expect(standardDevnetSigner(adapter(["solana:mainnet"], sign), payer.publicKey)).toBeNull();
    expect(standardDevnetSigner(adapter(["solana:devnet"], sign), Keypair.generate().publicKey)).toBeNull();
    expect(standardDevnetSigner(null, payer.publicKey)).toBeNull();
  });
});

import { asWalletRequestError, WalletRequestClosedError, WALLET_REQUEST_CLOSED_COPY } from "@/lib/v22/sign-guard";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError, UserFacingError, userFacingMessage } from "@/lib/errorMessages";

describe("RT5-2: an expired / closed wallet popup gets one friendly line", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });
  const COPY = "The wallet request timed out. Nothing was sent — try again.";

  it("wallet errors that are not a decline or a locked wallet become the timed-out line, through every resolver", async () => {
    const c = conn(DEVNET_GENESIS_HASH);
    for (const raw of [new Error("Popup closed"), new Error(""), Object.assign(new Error("Request timed out"), { name: "WalletSignTransactionError" }), new Error("Unexpected error")]) {
      noteBlockhash(BH, "sendTx attempt 1", c);
      const thrown = await guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign: async () => { throw raw; } }).catch((e) => e);
      expect(thrown).toBeInstanceOf(WalletRequestClosedError);
      expect((thrown as Error).message).toBe(COPY);
      expect(WALLET_REQUEST_CLOSED_COPY).toBe(COPY);
      expect((thrown as { cause?: unknown }).cause).toBe(raw);
      expect(resolveUserMessage(thrown, {}).body).toBe(COPY);
      expect(resolveUserMessage(new Error((thrown as Error).message), {}).body).toBe(COPY); // re-wrapped by a hook
      expect(humanizeError((thrown as Error).message)).toBe(COPY);
      expect(userFacingMessage(thrown)).toBe(COPY);
    }
  });

  it("NEGATIVE CONTROL: the same raw wallet text without the guard is the generic line", () => {
    expect(resolveUserMessage(new Error("Popup closed"), {}).body).toBe("Something went wrong and nothing was sent.");
    expect(humanizeError("Popup closed")).toBe("Something went wrong and nothing was sent.");
  });

  it("a decline, a locked wallet and an explained app error keep their own meaning", () => {
    const declined = new Error("User rejected the request.");
    const coded = Object.assign(new Error("x"), { code: 4001 });
    const locked = new Error("Wallet is locked");
    const own = new UserFacingError("Close your position first.");
    const expired = new Error("Transaction has expired: block height exceeded");
    for (const e of [declined, coded, locked, own, expired]) expect(asWalletRequestError(e)).toBe(e);
  });
});

import { chainSignerNote } from "@/lib/v22/standard-sign";
import { formatSignEntry as fmt } from "@/lib/v22/sign-guard";
describe("NB-2 round i: why a request did or did not carry the chain", () => {
  const acct = (chains: string[], features = ["solana:signTransaction"]) => ({ address: payer.publicKey.toBase58(), chains, features });
  const std = (accounts: unknown[], withFeature = true) => ({ name: "Solflare", standard: true, wallet: { accounts, features: withFeature ? { "solana:signTransaction": { signTransaction: async () => [] } } : {} } });
  it("names each reason", () => {
    expect(chainSignerNote(std([acct(["solana:devnet"])]), payer.publicKey)).toBe("standard Solflare + chain solana:devnet");
    expect(chainSignerNote({ name: "Solflare" }, payer.publicKey)).toContain("legacy adapter Solflare");
    expect(chainSignerNote(std([]), payer.publicKey)).toContain("account not in wallet.accounts (0 listed)");
    expect(chainSignerNote(std([acct(["solana:mainnet"])]), payer.publicKey)).toContain("lack solana:devnet");
    expect(chainSignerNote(std([acct(["solana:devnet"], [])]), payer.publicKey)).toContain("account lacks solana:signTransaction");
    expect(chainSignerNote(std([acct(["solana:devnet"])], false), payer.publicKey)).toContain("no solana:signTransaction feature");
    expect(chainSignerNote(null, payer.publicKey)).toBe("no adapter");
  });
  it("the debug line carries signer and the gap since the previous request", async () => {
    __setDevnetV22ForTest(true); __resetSignGuardForTest();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const c = conn(DEVNET_GENESIS_HASH);
    let clock = 1_000_000;
    noteBlockhash(BH, "sendTx attempt 1", c);
    await guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", signerNote: "standard Solflare + chain solana:devnet", now: () => clock, sign: async () => 1 });
    clock += 42_000;
    noteBlockhash(BH, "sendTx attempt 1", c);
    await guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", signerNote: "standard Solflare + chain solana:devnet", now: () => clock, sign: async () => 2 });
    expect(fmt(signLog()[1])).toContain("| signer standard Solflare + chain solana:devnet | 42.0s since the previous request |");
    expect(fmt(signLog()[0])).not.toContain("since the previous request");
    __setDevnetV22ForTest(null); vi.restoreAllMocks();
  });
});
