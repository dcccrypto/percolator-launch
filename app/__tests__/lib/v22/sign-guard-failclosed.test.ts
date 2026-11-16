// @vitest-environment node
/**
 * Fail-closed coverage for lib/v22/sign-guard.ts: every path where the guard cannot prove the transaction is for
 * devnet must refuse before the wallet opens (sign() never called), and the paths that are documented as "proves
 * nothing" are pinned so a refactor cannot silently flip them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import {
  __resetSignGuardForTest, asWalletRequestError, dismissSignProblem, formatSignEntry, forbiddenKeysIn, guardSign,
  isSignDebugEnabled, lastSignProblem, noteBlockhash, SIGN_DEBUG_KEY, SignGuardError, signLog, subscribeSignGuard,
  txShape, WalletRequestClosedError,
  type SignLogEntry,
} from "@/lib/v22/sign-guard";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const UNKNOWN_PROGRAM = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const payer = Keypair.generate();
const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type Conn = Parameters<typeof guardSign>[0]["connection"];
function conn(opts: { genesis?: string | Error; valid?: boolean | Error; accounts?: unknown } = {}): Conn & { isBlockhashValid: ReturnType<typeof vi.fn> } {
  const { genesis = DEVNET_GENESIS_HASH, valid = true } = opts;
  const c: Record<string, unknown> = {
    getGenesisHash: vi.fn(async () => { if (genesis instanceof Error) throw genesis; return genesis; }),
    isBlockhashValid: vi.fn(async () => { if (valid instanceof Error) throw valid; return { context: { slot: 1 }, value: valid }; }),
  };
  if (opts.accounts !== undefined) c.getMultipleAccountsInfo = vi.fn(async () => opts.accounts);
  return c as never;
}
function tx(blockhash: string | null = BH, programId = UNKNOWN_PROGRAM, keys: PublicKey[] = [payer.publicKey]): Transaction {
  const t = new Transaction().add(new TransactionInstruction({
    programId, keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.alloc(0),
  }));
  if (blockhash !== null) t.recentBlockhash = blockhash;
  t.feePayer = payer.publicKey;
  return t;
}
const params = (c: Conn, t: Transaction[], sign: () => Promise<unknown>, extra: object = {}) =>
  ({ txs: t, via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign, now: () => 5_000, ...extra }) as Parameters<typeof guardSign>[0];

describe("sign-guard fail-closed paths", () => {
  beforeEach(() => {
    __setDevnetV22ForTest(true); __resetSignGuardForTest();
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("flag off: calls the wallet directly, records nothing, checks nothing", async () => {
    __setDevnetV22ForTest(false);
    const c = conn({ genesis: MAINNET_GENESIS });
    const sign = vi.fn(async () => "s");
    await expect(guardSign(params(c, [tx()], sign))).resolves.toBe("s");
    expect(signLog()).toHaveLength(0);
    expect(c.getGenesisHash).not.toHaveBeenCalled();
    noteBlockhash(BH, "x"); // no-op with the flag off
  });

  it("untagged blockhash that the devnet RPC says is unknown: REFUSED, wallet never asked", async () => {
    const sign = vi.fn(async () => "s");
    await expect(guardSign(params(conn({ valid: false }), [tx()], sign))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()).toMatchObject({ verdict: "REFUSED-blockhash-not-on-devnet", wallet: "not-asked" });
    expect(signLog()[0].wallet).toBe("not-asked");
  });

  it("transaction with no blockhash at all (unknown to devnet) is refused, not allowed", async () => {
    const sign = vi.fn(async () => "s");
    await expect(guardSign(params(conn({ valid: false }), [tx(null)], sign))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()?.blockhash).toBe("");
  });

  it("untagged blockhash + RPC error: documented as 'proves nothing' (allowed, flagged untagged), never silently ok", async () => {
    const sign = vi.fn(async () => "s");
    await guardSign(params(conn({ valid: new Error("rpc down") }), [tx()], sign));
    expect(sign).toHaveBeenCalledTimes(1);
    expect(signLog()[0]).toMatchObject({ verdict: "untagged-blockhash", validAtHandoff: null });
    expect(lastSignProblem()?.verdict).toBe("untagged-blockhash");
  });

  it("untagged blockhash + RPC timeout: same as an RPC error, bounded by rpcTimeoutMs", async () => {
    const c = conn();
    c.isBlockhashValid.mockImplementation(() => new Promise(() => {}));
    const sign = vi.fn(async () => "s");
    await guardSign(params(c, [tx()], sign, { rpcTimeoutMs: 5 }));
    expect(signLog()[0]).toMatchObject({ verdict: "untagged-blockhash", validAtHandoff: null });
  });

  it("genesis hash on the app connection is mainnet: REFUSED-wrong-cluster", async () => {
    const sign = vi.fn(async () => "s");
    await expect(guardSign(params(conn({ genesis: MAINNET_GENESIS }), [tx()], sign))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()?.verdict).toBe("REFUSED-wrong-cluster");
  });

  it("genesis RPC error: devnet-guard treats it as unproven (not refused); the blockhash check still decides", async () => {
    const sign = vi.fn(async () => "s");
    // unproven cluster + blockhash devnet says is unknown => still refused
    await expect(guardSign(params(conn({ genesis: new Error("down"), valid: false }), [tx()], sign))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()?.verdict).toBe("REFUSED-blockhash-not-on-devnet");
  });

  it("tagged on devnet origin, but the app connection is mainnet: refused via the second check", async () => {
    const origin = conn();
    noteBlockhash(BH, "p", origin, 1_000);
    const sign = vi.fn(async () => "s");
    await expect(guardSign(params(conn({ genesis: MAINNET_GENESIS }), [tx()], sign))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(lastSignProblem()).toMatchObject({ verdict: "REFUSED-wrong-cluster", path: "p" });
  });

  it("batch: one refused tx refuses the whole batch and no tx is left 'pending'", async () => {
    const c = conn({ valid: true });
    noteBlockhash(BH, "good", c, 4_000);
    const sign = vi.fn(async () => "s");
    // second tx carries a blockhash devnet does not know and that was never tagged
    c.isBlockhashValid.mockImplementation(async (h: string) => ({ context: { slot: 1 }, value: h === BH }));
    await expect(guardSign(params(c, [tx(), tx("1111111111111111111111111111111Q")], sign))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
    expect(signLog().map((e) => e.wallet)).toEqual(["not-asked", "not-asked"]);
    expect(signLog()[1].via).toBe("adapter signTransaction[2/2]");
  });

  it("stale (RPC says no longer valid at handoff) is reported but not refused", async () => {
    const c = conn({ valid: false });
    noteBlockhash(BH, "p", c, 4_900);
    await expect(guardSign(params(c, [tx()], async () => "s"))).resolves.toBe("s");
    expect(signLog()[0]).toMatchObject({ verdict: "stale-blockhash", validAtHandoff: false });
  });

  it("origins older than the TTL are dropped on the next note, so that blockhash reads untagged (and unknown => refused)", async () => {
    const c = conn({ valid: false });
    noteBlockhash(BH, "old", c, 0);
    noteBlockhash("other", "new", c, 200_000);
    const sign = vi.fn(async () => "s");
    await expect(guardSign(params(c, [tx()], sign, { now: () => 200_001 }))).rejects.toBeInstanceOf(SignGuardError);
    expect(sign).not.toHaveBeenCalled();
  });

  describe("absent-account check", () => {
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], UNKNOWN_PROGRAM)[0];
    const other = Keypair.generate().publicKey;
    const fresh = () => { const c = conn({ accounts: [null, null, null] }); noteBlockhash(BH, "p", c, 4_000); return c; };

    it("missing accounts are diagnostics only: they do not refuse, but never read as 'all accounts on devnet'", async () => {
      const c = fresh();
      await guardSign(params(c, [tx(BH, UNKNOWN_PROGRAM, [payer.publicKey, other, pda])], async () => "s"));
      const e = signLog()[0];
      expect(e.verdict).toBe("ok");
      expect(e.absentOnDevnet).toEqual([`w:${payer.publicKey.toBase58()}`, `w:${other.toBase58()}`]);
      expect(e.absentPdas).toEqual([`w:${pda.toBase58()}`]);
      const line = formatSignEntry(e);
      expect(line).toContain("not on devnet:");
      expect(line).toContain("1 program-derived address with");
    });

    it("an account the tx creates is listed as created, not suspect", async () => {
      const created = Keypair.generate().publicKey;
      const t = new Transaction().add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: created, lamports: 1, space: 1, programId: UNKNOWN_PROGRAM }));
      t.recentBlockhash = BH; t.feePayer = payer.publicKey;
      const c = conn({ accounts: [null, null, null] }); noteBlockhash(BH, "p", c, 4_000);
      await guardSign(params(c, [t], async () => "s"));
      const e = signLog()[0];
      expect(e.absentCreated).toEqual([`w:${created.toBase58()}`]);
      expect(formatSignEntry(e)).toContain("1 new account this tx creates");
    });

    it("RPC error / timeout / no method / no accounts: absentOnDevnet is null or empty, never a refusal", async () => {
      const c1 = conn(); (c1 as { getMultipleAccountsInfo?: unknown }).getMultipleAccountsInfo = vi.fn(async () => { throw new Error("boom"); });
      noteBlockhash(BH, "p", c1, 4_000);
      await guardSign(params(c1, [tx()], async () => "s"));
      expect(signLog()[0].absentOnDevnet).toBeNull();
      expect(formatSignEntry(signLog()[0])).toContain("accounts not checked");

      const c2 = conn(); (c2 as { getMultipleAccountsInfo?: unknown }).getMultipleAccountsInfo = vi.fn(() => new Promise(() => {}));
      noteBlockhash(BH, "p", c2, 4_000);
      await guardSign(params(c2, [tx()], async () => "s", { rpcTimeoutMs: 5 }));
      expect(signLog()[1].absentOnDevnet).toBeNull();

      const c3 = conn(); noteBlockhash(BH, "p", c3, 4_000);
      await guardSign(params(c3, [tx()], async () => "s"));
      expect(signLog()[2].absentOnDevnet).toBeNull();

      const c4 = conn({ accounts: [] }); noteBlockhash(BH, "p", c4, 4_000);
      const empty = new Transaction(); empty.recentBlockhash = BH; empty.feePayer = payer.publicKey;
      await guardSign(params(c4, [empty], async () => "s"));
      expect(signLog()[3].absentOnDevnet).toEqual([]);
      expect(formatSignEntry(signLog()[3])).toContain("all accounts on devnet");
    });
  });

  describe("wallet failure classification", () => {
    const c = () => { const k = conn(); noteBlockhash(BH, "p", k, 4_000); return k; };

    it("blockhash that the RPC says has expired: a decline-class rejection reads as expiry (WalletRequestClosedError)", async () => {
      const k = c();
      let calls = 0;
      k.isBlockhashValid.mockImplementation(async () => ({ context: { slot: 1 }, value: ++calls === 1 }));
      const err = Object.assign(new Error("Transaction cancelled"), { code: 4001 });
      const thrown = await guardSign(params(k, [tx()], async () => { throw err; }, { now: () => 5_000 })).catch((e) => e);
      expect(thrown).toBeInstanceOf(WalletRequestClosedError);
      expect(signLog()[0].classified).toContain("expired: rpc-invalid");
    });

    it("expiry check with an RPC error or a missing blockhash proves nothing: stays a plain decline", async () => {
      const k = c();
      let calls = 0;
      k.isBlockhashValid.mockImplementation(async () => { if (++calls > 1) throw new Error("down"); return { context: { slot: 1 }, value: true }; });
      const err = Object.assign(new Error("Transaction cancelled"), { code: 4001 });
      const thrown = await guardSign(params(k, [tx()], async () => { throw err; })).catch((e) => e);
      expect(thrown).toBe(err);
      expect(signLog()[0].classified).toContain("cancelled (decline-class");
    });

    it("string rejections: a decline text is decline-class; other text becomes the closed-window error", async () => {
      const k = c();
      await expect(guardSign(params(k, [tx()], async () => { throw "User rejected the request"; }))).rejects.toBe("User rejected the request");
      expect(signLog()[0].classified).toContain("decline-class");
      const k2 = c();
      await expect(guardSign(params(k2, [tx()], async () => { throw "weird"; }))).rejects.toBeInstanceOf(WalletRequestClosedError);
      expect(signLog()[1].walletError).toBe("weird");
    });

    it("overlapping requests are marked", async () => {
      const k = c();
      let release!: () => void;
      const first = guardSign(params(k, [tx()], () => new Promise<string>((r) => { release = () => r("a"); })));
      await vi.waitFor(() => expect(signLog()).toHaveLength(1));
      const k2 = c();
      await guardSign(params(k2, [tx()], async () => "b"));
      release(); await first;
      expect(signLog()[1].overlapping).toBe(true);
      expect(formatSignEntry(signLog()[1])).toContain("still open");
    });

    it("asWalletRequestError: non-Error/null inputs fall to the closed-window error", () => {
      expect(asWalletRequestError(null)).toBeInstanceOf(WalletRequestClosedError);
      expect(asWalletRequestError({ message: "odd" })).toBeInstanceOf(WalletRequestClosedError);
    });
  });

  describe("helpers", () => {
    it("log is capped at 50 entries", async () => {
      for (let i = 0; i < 52; i++) { const k = conn(); noteBlockhash(BH, `p${i}`, k, 4_000); await guardSign(params(k, [tx()], async () => "s")); }
      expect(signLog()).toHaveLength(50);
      expect(signLog()[0].path).toBe("p2");
    });

    it("forbiddenKeysIn finds a mainnet-only program id and key; txShape tags unknown programs and empty data", () => {
      const bad = Keypair.generate().publicKey;
      const t = tx(BH, UNKNOWN_PROGRAM, [bad]);
      expect(forbiddenKeysIn(t, new Set([UNKNOWN_PROGRAM.toBase58()]))).toEqual([UNKNOWN_PROGRAM.toBase58()]);
      expect(forbiddenKeysIn(t, new Set([bad.toBase58()]))).toEqual([bad.toBase58()]);
      expect(forbiddenKeysIn(t, new Set())).toEqual([]);
      expect(forbiddenKeysIn({} as never, new Set(["x"]))).toEqual([]);
      expect(txShape(t)).toBe(`${UNKNOWN_PROGRAM.toBase58().slice(0, 4)}:-1`);
      expect(txShape({} as never)).toBe("");
      expect(txShape({ instructions: [{}] } as never)).toBe("?");
    });

    it("dismissSignProblem clears the last problem and notifies subscribers; unsubscribe stops it", async () => {
      await expect(guardSign(params(conn({ genesis: MAINNET_GENESIS }), [tx()], async () => "s"))).rejects.toBeInstanceOf(SignGuardError);
      const fn = vi.fn();
      const off = subscribeSignGuard(fn);
      dismissSignProblem();
      expect(lastSignProblem()).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
      off(); dismissSignProblem();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("formatSignEntry renders unknown age and optional signer/gap", () => {
      const e = { at: "t", via: "v", path: "p", blockhash: "abcdefghij", blockhashAgeMs: null, fetchCommitment: null, lastValidBlockHeight: null, validAtHandoff: null, shape: "s", chain: "c", verdict: "ok", absentOnDevnet: null, wallet: "signed", signer: "S", sinceLastMs: 2500 } as SignLogEntry;
      const line = formatSignEntry(e);
      expect(line).toContain("age unknown");
      expect(line).toContain("signer S");
      expect(line).toContain("2.5s since the previous request");
    });

    it("isSignDebugEnabled: false without window; ?signdebug=1/0 toggles; storage failure reads false", () => {
      expect(isSignDebugEnabled()).toBe(false);
      const store = new Map<string, string>();
      const win = {
        location: { search: "?signdebug=1" },
        localStorage: { setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), getItem: (k: string) => store.get(k) ?? null },
      };
      vi.stubGlobal("window", win);
      expect(isSignDebugEnabled()).toBe(true);
      expect(store.get(SIGN_DEBUG_KEY)).toBe("1");
      win.location.search = "?signdebug=0";
      expect(isSignDebugEnabled()).toBe(false);
      vi.stubGlobal("window", { location: { search: "" }, localStorage: { getItem: () => { throw new Error("denied"); } } });
      expect(isSignDebugEnabled()).toBe(false);
    });
  });
});
