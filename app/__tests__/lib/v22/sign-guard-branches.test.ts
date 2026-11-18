// @vitest-environment node
/**
 * Branch coverage for lib/v22/sign-guard.ts, with real transactions (real instruction data + account metas):
 * origin bookkeeping, shape/forbidden-key helpers, the account-presence probe, the expiry probe, and error shaping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import {
  __resetSignGuardForTest, accountsCreatedIn, asWalletRequestError, forbiddenKeysIn, formatSignEntry, guardSign, lastSignProblem, noteBlockhash,
  signLog, SignGuardError, txShape, WalletRequestClosedError, type SignLogEntry,
} from "@/lib/v22/sign-guard";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const OTHER = new PublicKey("4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT");
const payer = Keypair.generate();
const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BH2 = "EkSnNWid2cvwEVnVx9aBqawnSiCNpXd7kzeoEMQQP1qm";

const conn = (extra: Record<string, unknown> = {}, valid: boolean | Error = true) => ({
  getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH),
  isBlockhashValid: vi.fn(async () => { if (valid instanceof Error) throw valid; return { context: { slot: 1 }, value: valid }; }),
  ...extra,
});
function wrapperTx(blockhash: string | null = BH, data = Buffer.from([10, 1, 2]), extraKey?: PublicKey): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
  const keys = [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }];
  if (extraKey) keys.push({ pubkey: extraKey, isSigner: false, isWritable: false }, { pubkey: extraKey, isSigner: false, isWritable: true });
  tx.add(new TransactionInstruction({ programId: WRAPPER, keys, data }));
  if (blockhash) tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  return tx;
}
const declined = () => Object.assign(new Error("User rejected the request"), { code: 4001 });

describe("sign-guard branches", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("noteBlockhash: flag off records nothing; old origins are evicted; commitment metadata is kept", async () => {
    __setDevnetV22ForTest(false);
    noteBlockhash(BH, "off", conn(), 1);
    __setDevnetV22ForTest(true);
    const c = conn();
    await guardSign({ txs: [wrapperTx()], via: "v", connection: c, chain: "solana:devnet", sign: async () => 1, now: () => 2 });
    expect(signLog()[0].path).toContain("UNTAGGED");

    noteBlockhash(BH, "old", c, 1_000);
    noteBlockhash(BH2, "new", c, 1_000 + 200_000, { commitment: "confirmed", lastValidBlockHeight: 77 }); // evicts "old"
    await guardSign({ txs: [wrapperTx(BH2)], via: "v", connection: c, chain: "solana:devnet", sign: async () => 1, now: () => 201_500 });
    expect(signLog()[1]).toMatchObject({ path: "new", fetchCommitment: "confirmed", lastValidBlockHeight: 77, blockhashAgeMs: 500 });
    await guardSign({ txs: [wrapperTx(BH)], via: "v", connection: c, chain: "solana:devnet", sign: async () => 1, now: () => 201_600 });
    expect(signLog()[2].path).toContain("UNTAGGED");
  });

  it("forbiddenKeysIn finds a forbidden program id and account key, ignores the rest, tolerates no instructions", () => {
    const tx = wrapperTx(BH, Buffer.from([1]), OTHER);
    expect(forbiddenKeysIn(tx, new Set([WRAPPER.toBase58(), OTHER.toBase58()])).sort()).toEqual([WRAPPER.toBase58(), OTHER.toBase58()].sort());
    expect(forbiddenKeysIn(tx, new Set(["nothing"]))).toEqual([]);
    expect(forbiddenKeysIn({} as Pick<Transaction, "instructions">, new Set(["x"]))).toEqual([]);
  });

  it("txShape: empty instruction data reads :-1, an unknown program shows its prefix, no instructions reads empty", () => {
    const tx = new Transaction().add(new TransactionInstruction({ programId: OTHER, keys: [], data: Buffer.alloc(0) }));
    expect(txShape(tx, WRAPPER.toBase58())).toBe(`${OTHER.toBase58().slice(0, 4)}:-1`);
    expect(txShape({} as Pick<Transaction, "instructions">)).toBe("");
  });

  it("formatSignEntry: singular/plural program-derived + created counts, and the age/commitment fallbacks", () => {
    const base: SignLogEntry = {
      at: "t", via: "v", path: "p", blockhash: BH, blockhashAgeMs: null, fetchCommitment: null, lastValidBlockHeight: null, validAtHandoff: null,
      shape: "w:1", chain: "c", verdict: "ok", absentOnDevnet: [], wallet: "signed",
    };
    expect(formatSignEntry({ ...base, absentPdas: ["r:a"], absentCreated: ["w:b"] })).toMatch(/\+1 program-derived address with.*\+1 new account this tx/);
    expect(formatSignEntry({ ...base, absentOnDevnet: ["r:x"], absentPdas: ["r:a", "r:b"], absentCreated: ["w:b", "w:c"] })).toMatch(/not on devnet: r:x \(\+2 program-derived addresses.*\+2 new accounts/);
    expect(formatSignEntry({ ...base, absentOnDevnet: null, absentPdas: [], absentCreated: [] })).toContain("accounts not checked");
  });

  it("the log keeps only the newest 50 requests and mirrors to window.__v22SignLog when a window exists", async () => {
    const w: { __v22SignLog?: unknown } = {};
    vi.stubGlobal("window", w);
    const c = conn();
    for (let i = 0; i < 52; i++) await guardSign({ txs: [wrapperTx()], via: `v${i}`, connection: c, chain: "solana:devnet", sign: async () => 1, now: () => 1_000 + i });
    expect(signLog()).toHaveLength(50);
    expect(signLog()[0].via).toBe("v2");
    expect(w.__v22SignLog).toBe(signLog());
  });

  it("asWalletRequestError: null, plain-object and string rejections become the closed-request error", () => {
    for (const e of [null, { message: "boom" }, "boom", undefined]) expect(asWalletRequestError(e)).toBeInstanceOf(WalletRequestClosedError);
  });

  it("a tx with no blockhash skips the pre-wallet confirmed probe; the multi-tx label shows i/n", async () => {
    const c = conn();
    await guardSign({ txs: [wrapperTx(null), wrapperTx(null)], via: "adapter signAll", connection: c, chain: "none", sign: async () => 1, now: () => 5 });
    expect(c.isBlockhashValid.mock.calls.filter((a) => (a[1] as { commitment: string }).commitment === "confirmed")).toHaveLength(0);
    expect(signLog().map((e) => e.via)).toEqual(["adapter signAll[1/2]", "adapter signAll[2/2]"]);
    expect(signLog()[0].blockhash).toBe("");
  });

  it("a blockhash tagged on a different (still devnet) connection is checked on both connections", async () => {
    const tagged = conn();
    const app = conn();
    noteBlockhash(BH, "other conn", tagged, 1_000);
    await guardSign({ txs: [wrapperTx()], via: "v", connection: app, chain: "solana:devnet", sign: async () => 1, now: () => 2_000 });
    expect(tagged.getGenesisHash).toHaveBeenCalled();
    expect(app.getGenesisHash).toHaveBeenCalled();
    expect(signLog()[0].verdict).toBe("ok");
  });

  it("NEGATIVE: a blockhash tagged on a devnet connection is still refused when the app connection is on another cluster", async () => {
    const tagged = conn();
    const app = conn({ getGenesisHash: vi.fn(async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") });
    noteBlockhash(BH, "other conn", tagged, 1_000);
    const sign = vi.fn(async () => 1);
    await expect(guardSign({ txs: [wrapperTx()], via: "v", connection: app, chain: "solana:devnet", sign, now: () => 2_000 })).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()!.verdict).toBe("REFUSED-wrong-cluster");
  });

  it("account probe: writable flag merges across metas, absent plain key is suspect, unrelated PDA and created accounts are explained", async () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], WRAPPER);
    const created = Keypair.generate().publicKey;
    const missing = Keypair.generate().publicKey;
    const tx = new Transaction();
    tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: created, lamports: 1, space: 0, programId: WRAPPER }));
    tx.add(new TransactionInstruction({
      programId: WRAPPER, data: Buffer.from([3]),
      keys: [
        { pubkey: missing, isSigner: false, isWritable: false }, { pubkey: missing, isSigner: false, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: created, isSigner: true, isWritable: true },
      ],
    }));
    tx.recentBlockhash = BH; tx.feePayer = payer.publicKey;
    const c = conn({ getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map((k) => (k.equals(payer.publicKey) || k.equals(WRAPPER) || k.equals(SystemProgram.programId) ? { lamports: 1 } : null))) });
    noteBlockhash(BH, "p", c, 1_000);
    await guardSign({ txs: [tx], via: "v", connection: c, chain: "solana:devnet", sign: async () => 1, now: () => 2_000 });
    const e = signLog()[0];
    expect(e.absentOnDevnet).toEqual([`w:${missing.toBase58()}`]);
    expect(e.absentPdas).toEqual([`r:${pda.toBase58()}`]);
    expect(e.absentCreated).toEqual([`w:${created.toBase58()}`]);
  });

  it("account probe: a tx with no account keys and a probe that never answers both read as unchecked/empty without blocking the wallet", async () => {
    const noKeys = new Transaction().add(new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.from([1]) }));
    noKeys.recentBlockhash = BH;
    const c1 = conn({ getMultipleAccountsInfo: vi.fn() });
    noteBlockhash(BH, "p", c1, 1_000);
    await guardSign({ txs: [noKeys], via: "v", connection: c1, chain: "c", sign: async () => 1, now: () => 2_000 });
    expect(c1.getMultipleAccountsInfo).not.toHaveBeenCalled();
    expect(signLog()[0].absentOnDevnet).toEqual([]);

    const c2 = conn({ getMultipleAccountsInfo: vi.fn(() => new Promise(() => {})) });
    noteBlockhash(BH, "p", c2, 1_000);
    await guardSign({ txs: [wrapperTx()], via: "v", connection: c2, chain: "c", sign: async () => 1, now: () => 2_000, rpcTimeoutMs: 5 });
    expect(signLog()[1].absentOnDevnet).toBeNull();
  });

  it("accountsCreatedIn: tolerates no instructions, a System instruction it cannot decode, and a Create without a second key", () => {
    expect(accountsCreatedIn({} as Pick<Transaction, "instructions">).size).toBe(0);
    const bad = new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.from([255, 255, 255, 255]) });
    const noSecondKey = new TransactionInstruction({
      programId: SystemProgram.programId, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data: SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: OTHER, lamports: 1, space: 0, programId: WRAPPER }).data,
    });
    expect(accountsCreatedIn(new Transaction().add(bad, noSecondKey)).size).toBe(0);
  });

  it("a declined request on a tx with no blockhash skips the RPC expiry probe and reads as a plain cancel", async () => {
    const c = conn();
    await expect(guardSign({ txs: [wrapperTx(null)], via: "v", connection: c, chain: "c", sign: async () => { throw declined(); }, now: () => 10 })).rejects.toBeTruthy();
    expect(c.isBlockhashValid.mock.calls.filter((x) => (x[1] as { commitment: string }).commitment === "confirmed")).toHaveLength(0);
    expect(lastSignProblem()!.classified).toContain("cancelled (decline-class, not expired)");
  });

  it("expiry probe: the RPC saying 'invalid' reads as an expiry; an RPC error or timeout proves nothing", async () => {
    // first guard probe (before the wallet) answers valid, the later one (after the decline) answers invalid
    const answers = [true, false];
    const c1 = conn();
    c1.isBlockhashValid = vi.fn(async () => ({ context: { slot: 1 }, value: answers.shift() ?? false }));
    noteBlockhash(BH, "p", c1, 1_000);
    await expect(guardSign({ txs: [wrapperTx()], via: "v", connection: c1, chain: "c", sign: async () => { throw declined(); }, now: () => 1_100 })).rejects.toBeInstanceOf(WalletRequestClosedError);
    expect(lastSignProblem()!.classified).toContain("rpc-invalid");

    let n = 0;
    const c2 = conn();
    c2.isBlockhashValid = vi.fn(async () => { n += 1; if (n <= 1) return { context: { slot: 1 }, value: true }; throw new Error("rpc down"); });
    noteBlockhash(BH, "p", c2, 1_000);
    await expect(guardSign({ txs: [wrapperTx()], via: "v", connection: c2, chain: "c", sign: async () => { throw declined(); }, now: () => 1_100 })).rejects.toBeTruthy();
    expect(lastSignProblem()!.classified).toContain("cancelled (decline-class, not expired)");
    expect(n).toBe(2);

    let m = 0;
    const c3 = conn();
    c3.isBlockhashValid = vi.fn(() => { m += 1; return m <= 1 ? Promise.resolve({ context: { slot: 1 }, value: true }) : new Promise(() => {}); }) as never;
    noteBlockhash(BH, "p", c3, 1_000);
    await expect(guardSign({ txs: [wrapperTx()], via: "v", connection: c3, chain: "c", sign: async () => { throw declined(); }, now: () => 1_100, rpcTimeoutMs: 5 })).rejects.toBeTruthy();
    expect(lastSignProblem()!.classified).toContain("cancelled (decline-class, not expired)");
    expect(m).toBe(2);
  });

  it("non-object rejections: a bare 'rejected' string is decline-class; a bare unrelated string is a closed request; both are described", async () => {
    const c = conn();
    await expect(guardSign({ txs: [wrapperTx(null)], via: "v", connection: c, chain: "c", sign: async () => { throw "User rejected the request"; }, now: () => 10 })).rejects.toBeTruthy();
    expect(lastSignProblem()!.classified).toContain("cancelled (decline-class");
    expect(lastSignProblem()!.rawError).toContain("User rejected");

    await expect(guardSign({ txs: [wrapperTx(null)], via: "v", connection: c, chain: "c", sign: async () => { throw "kaboom"; }, now: () => 10 })).rejects.toBeInstanceOf(WalletRequestClosedError);
    expect(lastSignProblem()!.classified).toContain("non-decline wallet error");
  });

  it("an error object whose layers are decline-class by text only (no code) is decline-class; a nested cause is looked through", async () => {
    const c = conn();
    const nested = { name: "WalletSignTransactionError", message: "x", cause: { message: "User rejected the request" } };
    await expect(guardSign({ txs: [wrapperTx(null)], via: "v", connection: c, chain: "c", sign: async () => { throw nested; }, now: () => 10 })).rejects.toBeTruthy();
    expect(lastSignProblem()!.classified).toContain("cancelled (decline-class");
    expect(lastSignProblem()!.rawError).toContain("WalletSignTransactionError");
  });
});
