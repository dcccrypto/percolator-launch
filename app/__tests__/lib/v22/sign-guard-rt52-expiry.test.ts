// @vitest-environment node
/**
 * v2.2 QA RT5-2 (retest 6): Solflare rejects an EXPIRED popup (~70 s) with JsonRpcError "Transaction cancelled", the
 * same text as a decline. Classified by elapsed time: lib/v22/sign-guard.ts WALLET_EXPIRY_MIN_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import { __resetSignGuardForTest, guardSign, noteBlockhash, WalletRequestClosedError, WALLET_EXPIRY_MIN_MS, isSignDebugEnabled, signLog } from "@/lib/v22/sign-guard";
import { firstTradeCancelledExtras, FIRST_TRADE_COPY } from "@/lib/first-trade";
import { resolveUserMessage } from "@/lib/limits/user-message";

const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const payer = Keypair.generate();
const conn = { getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH), isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })) };
function tx(): Transaction {
  const t = new Transaction();
  t.add(new TransactionInstruction({ programId: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"), keys: [], data: Buffer.from([10]) }));
  t.recentBlockhash = BH;
  t.feePayer = payer.publicKey;
  return t;
}
const TIMEOUT_COPY = "The wallet request timed out. Nothing was sent — try again.";
const solflareCancel = () => Object.assign(new Error("Transaction cancelled"), { name: "JsonRpcError" });

/** A wallet that rejects after `afterMs` of (fake) clock time. */
async function reject(err: Error, afterMs: number): Promise<unknown> {
  let clock = 1_000;
  noteBlockhash(BH, "sendTx attempt 1", conn, clock);
  return guardSign({
    txs: [tx()], via: "adapter signTransaction", connection: conn, chain: "solana:devnet", now: () => clock,
    sign: async () => { clock += afterMs; throw err; },
  }).catch((e) => e);
}

/** Round f: the blockhash was noted `ageAtOpenMs` before the wallet opened; the wallet answers `afterMs` later; the RPC says `valid`. */
async function rejectWithBlockhash(err: unknown, ageAtOpenMs: number, afterMs: number, valid: boolean | "throws" = true): Promise<unknown> {
  let clock = 1_000_000;
  const c = { getGenesisHash: conn.getGenesisHash, isBlockhashValid: vi.fn(async () => { if (valid === "throws") throw new Error("rpc down"); return { context: { slot: 1 }, value: valid }; }) };
  noteBlockhash(BH, "sendTx attempt 1", c, clock - ageAtOpenMs);
  return guardSign({
    txs: [tx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", now: () => clock,
    sign: async () => { clock += afterMs; throw err; },
  }).catch((e) => e);
}
// What Solflare really throws: a JsonRpcError-like plain object, not an Error.
const jsonRpcLike = () => ({ code: -32000, message: "Transaction cancelled", name: "JsonRpcError" });

describe("RT5-2 round f: the transaction expired while the popup was open", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("a plain {code,message} JsonRpcError after the threshold -> timeout copy", async () => {
    const thrown = await reject(jsonRpcLike() as unknown as Error, 70_000);
    expect(thrown).toBeInstanceOf(WalletRequestClosedError);
    expect(resolveUserMessage(thrown, { surface: "trade" }).body).toBe(TIMEOUT_COPY);
  });
  it("answered quickly, but the blockhash is already older than the window by then -> timeout copy", async () => {
    expect(await rejectWithBlockhash(solflareCancel(), 50_000, 6_000)).toBeInstanceOf(WalletRequestClosedError);
  });
  it("answered quickly, blockhash no longer valid on the RPC -> timeout copy", async () => {
    expect(await rejectWithBlockhash(solflareCancel(), 5_000, 3_000, false)).toBeInstanceOf(WalletRequestClosedError);
  });
  it("fast decline with a fresh, valid blockhash stays Cancelled; an RPC failure proves nothing", async () => {
    for (const v of [true, "throws"] as const) {
      const thrown = await rejectWithBlockhash(solflareCancel(), 5_000, 3_000, v);
      expect(thrown).not.toBeInstanceOf(WalletRequestClosedError);
      expect(resolveUserMessage(thrown, { surface: "trade" }).body).toBe("Cancelled.");
    }
  });
  it("the Phantom Testnet-Mode hint is Phantom-only: absent for Solflare, null and unknown wallets", () => {
    expect(firstTradeCancelledExtras("Phantom", true).why).toContain("Phantom");
    for (const n of ["Solflare", "Backpack", null, undefined]) expect(firstTradeCancelledExtras(n, true)).toEqual({ body: FIRST_TRADE_COPY.cancelled });
    expect(firstTradeCancelledExtras("Phantom", false).why).toBeUndefined();
  });
  it("a timeout never takes the 'cancelled' branch (so never carries the hint)", async () => {
    const um = resolveUserMessage(await reject(solflareCancel(), 70_000), { surface: "trade", oneShot: true });
    expect(um.kind).toBe("wallet-request-closed");
    expect(um.quiet).toBeFalsy();
  });
});

describe("RT5-2 expiry vs decline", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("slow 'Transaction cancelled' (popup expired) -> timeout copy", async () => {
    for (const ms of [WALLET_EXPIRY_MIN_MS, 70_000, 90_000]) {
      const thrown = await reject(solflareCancel(), ms);
      expect(thrown).toBeInstanceOf(WalletRequestClosedError);
      expect(resolveUserMessage(thrown, {}).body).toBe(TIMEOUT_COPY);
    }
  });

  it("slow 4001 / 'User rejected' is also an expiry", async () => {
    expect(resolveUserMessage(await reject(Object.assign(new Error("x"), { code: 4001 }), 70_000), {}).body).toBe(TIMEOUT_COPY);
    expect(resolveUserMessage(await reject(new Error("User rejected the request."), 70_000), {}).body).toBe(TIMEOUT_COPY);
  });

  it("fast 'Transaction cancelled' stays a decline", async () => {
    for (const ms of [0, 2_000, WALLET_EXPIRY_MIN_MS - 1]) {
      const thrown = await reject(solflareCancel(), ms);
      expect(thrown).not.toBeInstanceOf(WalletRequestClosedError);
      expect(resolveUserMessage(thrown, {}).body).not.toBe(TIMEOUT_COPY);
      expect(resolveUserMessage(thrown, {}).body).toBe("Cancelled.");
    }
  });

  it("a slow locked wallet / expired blockhash keep their own meaning", async () => {
    const locked = new Error("Wallet is locked");
    const expired = new Error("Transaction has expired: block height exceeded");
    expect(await reject(locked, 90_000)).toBe(locked);
    expect(await reject(expired, 90_000)).toBe(expired);
  });

  it("the sign log still records the request as declined", async () => {
    await reject(solflareCancel(), 70_000);
    expect(signLog()[0]).toMatchObject({ wallet: "declined", walletError: expect.stringContaining("Transaction cancelled") });
  });

  it("debug line opt-in: off without window; helper reads ?signdebug=1 / localStorage", () => {
    expect(isSignDebugEnabled()).toBe(false);
    const store = new Map<string, string>();
    const win = { location: { search: "" }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
    vi.stubGlobal("window", win);
    try {
      expect(isSignDebugEnabled()).toBe(false);
      win.location.search = "?signdebug=1";
      expect(isSignDebugEnabled()).toBe(true);
      win.location.search = "";
      expect(isSignDebugEnabled()).toBe(true); // remembered
      win.location.search = "?signdebug=0";
      expect(isSignDebugEnabled()).toBe(false);
      win.location.search = "";
      expect(isSignDebugEnabled()).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

import { formatSignEntry, signLog as signLogRT } from "@/lib/v22/sign-guard";
import { HANDOFF_BLOCKHASH_MAX_AGE_MS, refreshBlockhashBeforeHandoff, getFreshBlockhash } from "@/lib/tx";

describe("NB-2 round f: what the sign log now records, and the hand-off refresh", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("the log carries the fetch commitment, lastValidBlockHeight, age and the pre-hand-off validity check", async () => {
    noteBlockhash(BH, "sendTx attempt 1", conn, 1_000, { commitment: "confirmed", lastValidBlockHeight: 123_456 });
    await guardSign({ txs: [tx()], via: "adapter signTransaction", connection: conn, chain: "solana:devnet", now: () => 3_000, sign: async () => "ok" });
    const e = signLogRT()[0];
    expect(e).toMatchObject({ fetchCommitment: "confirmed", lastValidBlockHeight: 123_456, blockhashAgeMs: 2_000, validAtHandoff: true });
    expect(formatSignEntry(e)).toContain("fetched@confirmed lvbh 123456 valid@handoff true");
  });

  it("a blockhash the RPC no longer knows at hand-off is reported (stale) in the log", async () => {
    const c = { ...conn, isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: false })) };
    noteBlockhash(BH, "sendTx attempt 1", c, 1_000, { commitment: "confirmed", lastValidBlockHeight: 1 });
    await guardSign({ txs: [tx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", now: () => 2_000, sign: async () => "ok" });
    expect(signLogRT()[0]).toMatchObject({ verdict: "stale-blockhash", validAtHandoff: false });
  });

  it("sendTx hand-off: a blockhash fetched before the planning/simulation is replaced when it has aged; a fresh one is kept", async () => {
    let n = 0;
    const c = { getGenesisHash: conn.getGenesisHash, isBlockhashValid: conn.isBlockhashValid, getLatestBlockhash: vi.fn(async () => ({ blockhash: `BH${++n}`, lastValidBlockHeight: 100 + n })) };
    const first = await getFreshBlockhash(c as never, true, "t");
    const t = { recentBlockhash: first };
    // fresh: untouched
    expect(await refreshBlockhashBeforeHandoff(c as never, t, Date.now())).toBe(false);
    expect(t.recentBlockhash).toBe("BH1");
    // aged past the limit: replaced by a newly fetched one
    expect(await refreshBlockhashBeforeHandoff(c as never, t, Date.now() + HANDOFF_BLOCKHASH_MAX_AGE_MS + 1)).toBe(true);
    expect(t.recentBlockhash).toBe("BH2");
    expect(c.getLatestBlockhash).toHaveBeenCalledWith("confirmed");
  });

  it("flag off: nothing is replaced", async () => {
    __setDevnetV22ForTest(false);
    const t = { recentBlockhash: "X" };
    expect(await refreshBlockhashBeforeHandoff({} as never, t, Date.now() + 999_999)).toBe(false);
    expect(t.recentBlockhash).toBe("X");
  });
});

import { WalletSignTransactionError } from "@solana/wallet-adapter-base";
describe("RT5-2 round g: lower threshold, wrapped errors, classification in the log", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });
  it("the window is 45 s: a popup that dies at 48 s (not 55) is an expiry", async () => {
    expect(WALLET_EXPIRY_MIN_MS).toBe(45_000);
    expect(await reject(solflareCancel(), 48_000)).toBeInstanceOf(WalletRequestClosedError);
  });
  it("wallet-adapter's WalletSignTransactionError: the wallet's {code} sits on .error, not the outer error", async () => {
    const wrapped = new WalletSignTransactionError("Something else entirely", { code: 4001, message: "Something else entirely" });
    expect(await reject(wrapped, 50_000)).toBeInstanceOf(WalletRequestClosedError);
    const fast = await reject(new WalletSignTransactionError("Something else entirely", { code: 4001 }), 2_000);
    expect(fast).not.toBeInstanceOf(WalletRequestClosedError); // a fast decline by code only is still a decline
  });
  it("the log (and the debug line) say elapsed, raw error layers and which branch classified it", async () => {
    await reject(new WalletSignTransactionError("Transaction cancelled", { code: -32603, message: "Transaction cancelled" }), 50_000);
    const e = signLog()[0];
    expect(e.classified).toBe("timeout copy (expired: open-time)");
    expect(e.elapsedMs).toBe(50_000);
    expect(e.rawError).toContain("WalletSignTransactionError");
    expect(e.rawError).toContain("-32603");
    expect(formatSignEntry(e)).toContain("open 50.0s");
    __resetSignGuardForTest();
    await reject(solflareCancel(), 1_000);
    expect(signLog()[0].classified).toBe("cancelled (decline-class, not expired)");
  });
});
