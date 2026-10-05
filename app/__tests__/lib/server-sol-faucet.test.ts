// @vitest-environment node
/**
 * Security review 2026-09-30 (WP-8..10 FIX-FIRST) on the server-wallet SOL faucet
 * (lib/server-sol-faucet.ts), each fix with a test:
 *  M-1 balance-aware top-up; one server send per wallet per day and a GLOBAL daily budget, both
 *      persisted in faucet_claims (a DB fake with the table's UNIQUE(wallet, fund_type)); a
 *      3-per-hour per-IP limit on this branch; over any of them the caller gets "skipped".
 *  L-1 after broadcast, anything but a definite on-chain failure is "pending" and the
 *      reservation is KEPT; a not-sent or definitely-failed send gives it back.
 *  L-2 the connection must be devnet (genesis hash) before anything is sent.
 *  I-1 an unreadable key logs a fixed string, never the parse error (which quotes the input).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import bs58 from "bs58";

const h = vi.hoisted(() => ({ confirm: null as null | ((sig: string) => Promise<void>) }));
vi.mock("@/lib/server-rpc", async () => {
  class ServerSignatureExecutionError extends Error {}
  return {
    ServerSignatureExecutionError,
    confirmServerSignature: async (_c: unknown, sig: string) => {
      if (h.confirm) await h.confirm(sig);
      return sig;
    },
  };
});
vi.mock("@/lib/upstash-rate-limit", () => {
  const hits = new Map<string, number>();
  return {
    createUpstashRateLimiter: (o: { limit: number }) => ({
      check: async (ip: string) => {
        const n = (hits.get(ip) ?? 0) + 1;
        hits.set(ip, n);
        return { allowed: n <= o.limit, retryAfterSecs: 60 };
      },
    }),
  };
});

const lib = await import("@/lib/server-sol-faucet");
const rpc = await import("@/lib/server-rpc");
const { DEVNET_GENESIS_HASH, SERVER_SOL_TARGET_LAMPORTS, grantServerSol, getSolFaucetSigner, __resetSolFaucetSignerForTest } = lib;

/** faucet_claims with its UNIQUE(wallet, fund_type), enough of the PostgREST builder for the lib. */
function fakeDb(opts: { uuid?: boolean } = {}) {
  let seq = 0;
  const rows: { id: number | string; wallet: string; fund_type: string; claimed_at: string }[] = [];
  const q = (filters: [string, string, unknown][] = []) => {
    const match = (r: Record<string, unknown>) =>
      filters.every(([op, k, v]) => (op === "eq" ? r[k] === v : op === "lt" ? String(r[k]) < String(v) : op === "gte" ? String(r[k]) >= String(v) : op === "lte" ? (typeof r[k] === "number" && typeof v === "number" ? (r[k] as number) <= v : String(r[k]) <= String(v)) : true));
    return { filters, match };
  };
  const table = {
    delete: () => {
      const st = q();
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "lt"]) b[op] = (k: string, v: unknown) => (st.filters.push([op, k, v]), b);
      b.then = (res: (v: unknown) => void) => {
        for (let i = rows.length - 1; i >= 0; i--) if (st.match(rows[i]!)) rows.splice(i, 1);
        res({ error: null });
      };
      return b;
    },
    insert: (r: { wallet: string; fund_type: string; claimed_at: string }) => ({
      select: () => ({
        maybeSingle: async () => {
          if (rows.some((x) => x.wallet === r.wallet && x.fund_type === r.fund_type)) return { data: null, error: { code: "23505" } };
          const row = { id: opts.uuid ? `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}` : ++seq, ...r };
          rows.push(row);
          return { data: { id: row.id }, error: null };
        },
      }),
    }),
    select: () => {
      const st = q();
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "gte", "lte"]) b[op] = (k: string, v: unknown) => (st.filters.push([op, k, v]), b);
      b.then = (res: (v: unknown) => void) => res({ count: rows.filter(st.match).length, error: null });
      return b;
    },
  };
  return { db: { from: () => table }, rows };
}

function conn(o: { balance?: number; genesis?: string; send?: () => Promise<string> } = {}) {
  const c = {
    sent: [] as number[],
    getBalance: vi.fn(async () => o.balance ?? 0),
    getGenesisHash: vi.fn(async () => o.genesis ?? DEVNET_GENESIS_HASH),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 })),
    sendRawTransaction: vi.fn(async () => (o.send ? o.send() : "sig-1")),
  };
  return c;
}

const KEY = Keypair.generate();
let ipN = 0;
const ip = () => `10.0.0.${++ipN}`;
const env = (extra: Record<string, string> = {}) => ({ PLAYGROUND_SOL_FAUCET_KEYPAIR: bs58.encode(KEY.secretKey), ...extra }) as unknown as NodeJS.ProcessEnv;
const to = () => Keypair.generate().publicKey;

beforeEach(() => {
  h.confirm = null;
  __resetSolFaucetSignerForTest();
});
afterEach(() => vi.restoreAllMocks());

describe("M-1: balance-aware, per-wallet, global budget, per-IP", () => {
  it("tops up to the target, never a blind amount; an already-funded wallet gets nothing", async () => {
    const { db } = fakeDb();
    const c = conn({ balance: 20_000_000 });
    const g = await grantServerSol({ connection: c as never, db, to: to(), ip: ip(), env: env() });
    expect(g).toMatchObject({ status: "sent", lamports: SERVER_SOL_TARGET_LAMPORTS - 20_000_000 });
    const c2 = conn({ balance: SERVER_SOL_TARGET_LAMPORTS });
    expect(await grantServerSol({ connection: c2 as never, db, to: to(), ip: ip(), env: env() })).toEqual({ status: "funded", lamports: 0 });
    expect(c2.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("one server send per wallet per day (the durable UNIQUE row)", async () => {
    const { db } = fakeDb();
    const w = to();
    expect((await grantServerSol({ connection: conn() as never, db, to: w, ip: ip(), env: env() })).status).toBe("sent");
    expect(await grantServerSol({ connection: conn() as never, db, to: w, ip: ip(), env: env() })).toEqual({ status: "skipped", reason: "wallet-limit" });
  });
  it("the global daily budget holds across fresh keypairs; over it the reservation is removed", async () => {
    const { db, rows } = fakeDb();
    const e = env({ PLAYGROUND_SOL_FAUCET_DAILY_SOL: "2" }); // 2 / 1 = 2 sends a day
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await grantServerSol({ connection: conn() as never, db, to: to(), ip: ip(), env: e })).status);
    expect(out).toEqual(["sent", "sent", "skipped", "skipped"]);
    expect(rows.filter((r) => r.fund_type === "server-sol")).toHaveLength(2);
  });
  it("3 per IP per hour on this branch", async () => {
    const { db } = fakeDb();
    const same = ip();
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await grantServerSol({ connection: conn() as never, db, to: to(), ip: same, env: env() }));
    expect(out.map((g) => g.status)).toEqual(["sent", "sent", "sent", "skipped"]);
    expect(out[3]).toEqual({ status: "skipped", reason: "ip-limit" });
  });
  it("no key or no database: skipped (the caller uses the public airdrop)", async () => {
    const { db } = fakeDb();
    expect(await grantServerSol({ connection: conn() as never, db, to: to(), ip: ip(), env: {} as NodeJS.ProcessEnv })).toEqual({ status: "skipped", reason: "disabled" });
    expect(await grantServerSol({ connection: conn() as never, db: null, to: to(), ip: ip(), env: env() })).toEqual({ status: "skipped", reason: "no-db" });
  });
});

describe("L-1: an ambiguous send is spent", () => {
  it("confirmation timeout -> pending, reservation kept", async () => {
    const { db, rows } = fakeDb();
    h.confirm = async () => {
      throw new Error("timeout");
    };
    const g = await grantServerSol({ connection: conn() as never, db, to: to(), ip: ip(), env: env() });
    expect(g).toEqual({ status: "pending", signature: "sig-1" });
    expect(rows).toHaveLength(1);
  });
  it("a lost send response -> pending (may have reached the leader), reservation kept", async () => {
    const { db, rows } = fakeDb();
    const g = await grantServerSol({ connection: conn({ send: async () => { throw new Error("socket hang up"); } }) as never, db, to: to(), ip: ip(), env: env() });
    expect(g.status).toBe("pending");
    expect(rows).toHaveLength(1);
  });
  it("refused before broadcast, or a definite on-chain failure -> skipped, reservation released", async () => {
    const { db, rows } = fakeDb();
    const refused = conn({ send: async () => { throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "blockhash not found" }); } });
    expect(await grantServerSol({ connection: refused as never, db, to: to(), ip: ip(), env: env() })).toEqual({ status: "skipped", reason: "failed" });
    h.confirm = async () => {
      throw new rpc.ServerSignatureExecutionError("failed on chain");
    };
    expect(await grantServerSol({ connection: conn() as never, db, to: to(), ip: ip(), env: env() })).toEqual({ status: "skipped", reason: "failed" });
    expect(rows).toHaveLength(0);
  });
});

describe("L-2: devnet only, checked on the cluster", () => {
  it("another genesis hash -> nothing is sent", async () => {
    const { db, rows } = fakeDb();
    const c = conn({ genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }); // mainnet-beta
    expect(await grantServerSol({ connection: c as never, db, to: to(), ip: ip(), env: env() })).toEqual({ status: "skipped", reason: "failed" });
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});

describe("I-1: key parse failures never log the input", () => {
  it("a malformed JSON-array key logs a fixed string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(getSolFaucetSigner({ PLAYGROUND_SOL_FAUCET_KEYPAIR: "[12,34,abcSECRET" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    const logged = spy.mock.calls.flat().map(String).join(" ");
    expect(logged).toBe("[server-sol-faucet] the SOL faucet key could not be read; the server SOL path is disabled");
    expect(logged).not.toMatch(/SECRET|abc|\[12/);
  });
});

describe("re-review I-D: a failed balance read falls back quietly", () => {
  it("getBalance throws -> skipped (the caller uses the public airdrop), nothing reserved or sent", async () => {
    const { db, rows } = fakeDb();
    const c = conn();
    c.getBalance.mockRejectedValue(new Error("429"));
    expect(await grantServerSol({ connection: c as never, db, to: to(), ip: ip(), env: env() })).toEqual({ status: "skipped", reason: "failed" });
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});

describe("2026-10-02 live: faucet_claims.id is a UUID in production", () => {
  it("a UUID-id reservation succeeds (was 'no-db', which disabled the server SOL path)", async () => {
    const { db } = fakeDb({ uuid: true });
    const r = await lib.reserveServerSol(db, "WALLET-A", Date.parse("2026-10-02T05:00:00Z"));
    expect(r).toHaveProperty("id");
    expect(typeof (r as { id: unknown }).id).toBe("string");
  });
  it("the daily budget is counted by claim time, so it still holds with UUID ids", async () => {
    const { db } = fakeDb({ uuid: true });
    const env = { PLAYGROUND_SOL_FAUCET_DAILY_SOL: "2" } as NodeJS.ProcessEnv; // 2 SOL / 1 = 2 sends
    const t0 = Date.parse("2026-10-02T05:00:00Z");
    expect(await lib.reserveServerSol(db, "W1", t0, env)).toHaveProperty("id");
    expect(await lib.reserveServerSol(db, "W2", t0 + 1000, env)).toHaveProperty("id");
    expect(await lib.reserveServerSol(db, "W3", t0 + 2000, env)).toEqual({ reason: "budget" });
  });
});

describe("#2760: reservation deletes check {error}, retry, and log the final failure", () => {
  type DelResult = { error: { message: string } | null };
  /**
   * Wraps fakeDb so that `.delete().eq("id", ...)` (the release / budget-overflow delete) resolves
   * with scripted results first (PostgREST reports failure as a returned {error}, it does not throw).
   * Once the script is exhausted it falls through to the real fake.
   */
  function flakyDeleteDb(script: DelResult[] | "always-error") {
    const inner = fakeDb();
    const calls = { byId: 0 };
    const realFrom = inner.db.from("faucet_claims");
    const table = {
      ...realFrom,
      delete: () => {
        const real = realFrom.delete() as unknown as { eq: (k: string, v: unknown) => unknown; lt: (k: string, v: unknown) => unknown; then: (r: (v: unknown) => void) => void };
        let byId = false;
        const b: Record<string, unknown> = {};
        b.eq = (k: string, v: unknown) => {
          if (k === "id") byId = true;
          real.eq(k, v);
          return b;
        };
        b.lt = (k: string, v: unknown) => (real.lt(k, v), b);
        b.then = (res: (v: unknown) => void) => {
          if (!byId) return real.then(res);
          calls.byId++;
          if (script === "always-error") return res({ error: { message: "db down" } });
          const next = script.shift();
          return next ? res(next) : real.then(res);
        };
        return b;
      },
    };
    return { db: { from: () => table }, rows: inner.rows, calls };
  }
  const refusedSend = () => conn({ send: async () => { throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "blockhash not found" }); } });

  it("release: a delete that returns {error} is retried and then succeeds (row removed)", async () => {
    const { db, rows, calls } = flakyDeleteDb([{ error: { message: "transient" } }]);
    const g = await grantServerSol({ connection: refusedSend() as never, db, to: to(), ip: ip(), env: env() });
    expect(g).toEqual({ status: "skipped", reason: "failed" });
    expect(calls.byId).toBe(2);
    expect(rows).toHaveLength(0);
  });

  it("release: always-error is bounded (<= 3 attempts) and the final failure is logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = flakyDeleteDb("always-error");
    const g = await grantServerSol({ connection: refusedSend() as never, db, to: to(), ip: ip(), env: env() });
    expect(g).toEqual({ status: "skipped", reason: "failed" });
    expect(calls.byId).toBeGreaterThanOrEqual(2);
    expect(calls.byId).toBeLessThanOrEqual(3);
    expect(err.mock.calls.some((c) => String(c[0]).includes("could not release reservation"))).toBe(true);
  });

  it("budget overflow: the over-cap delete is retried on {error} and the row ends up removed", async () => {
    const { db, rows, calls } = flakyDeleteDb([{ error: { message: "transient" } }]);
    const e = { PLAYGROUND_SOL_FAUCET_DAILY_SOL: "1" } as NodeJS.ProcessEnv; // 1 send / day
    const t0 = Date.parse("2026-10-02T05:00:00Z");
    expect(await lib.reserveServerSol(db, "W1", t0, e)).toHaveProperty("id");
    expect(await lib.reserveServerSol(db, "W2", t0 + 1000, e)).toEqual({ reason: "budget" });
    expect(calls.byId).toBe(2);
    expect(rows.map((r) => r.wallet)).toEqual(["W1"]);
  });

  it("budget overflow: always-error is bounded and logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = flakyDeleteDb("always-error");
    const e = { PLAYGROUND_SOL_FAUCET_DAILY_SOL: "1" } as NodeJS.ProcessEnv;
    const t0 = Date.parse("2026-10-02T05:00:00Z");
    await lib.reserveServerSol(db, "W1", t0, e);
    expect(await lib.reserveServerSol(db, "W2", t0 + 1000, e)).toEqual({ reason: "budget" });
    expect(calls.byId).toBeGreaterThanOrEqual(2);
    expect(calls.byId).toBeLessThanOrEqual(3);
    expect(err.mock.calls.some((c) => String(c[0]).includes("could not release reservation"))).toBe(true);
  });
});
