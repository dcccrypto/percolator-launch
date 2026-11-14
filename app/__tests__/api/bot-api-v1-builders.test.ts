// @vitest-environment node
/**
 * /api/v1 builders: orders, positions/close, deposits, withdrawals, orders/cancel, tx status.
 * The trade builder is mocked at its boundary (its own tests cover it over a real market fixture); everything the v1
 * layer adds is real: parsing, caps via the preflight, the exact-bytes simulation, idempotency, error mapping.
 * Deposit / withdraw run on the real GATO devnet market bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { NextRequest } from "next/server";

const fx = JSON.parse(readFileSync(join(__dirname, "../fixtures/v22-trade-build/gato-market.json"), "utf8")) as { slab: string; owner: string; data: string };
const WRAPPER = new PublicKey(fx.owner);
const SLAB = new PublicKey(fx.slab);
const MARKET_DATA = Buffer.from(fx.data, "base64");
const OWNER = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const BH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

const m = vi.hoisted(() => ({
  pre: { effectivePriceE6: 2_000_000n, positionBeforeQ: 0n as bigint | null, reducing: false },
  guards: 0,
  guardThrow: null as unknown,
  buildCalls: 0,
  buildThrow: null as unknown,
  resubmit: false,
  finalSims: [] as Array<{ err: unknown; logs?: string[] }>,
  simTxs: [] as VersionedTransaction[],
  gate: { err: null as unknown, logs: [] as string[] },
  portfolioFound: true,
  pf: { capital: 50_000_000n, legs: [] as { active: boolean }[], owner: null as unknown, marketGroupId: null as unknown },
  ataBalance: 100_000_000n as bigint | null,
  newPortfolioExists: false,
  fresh: null as string | null,
  position: 0n,
  sigStatus: null as null | { slot: number; confirmations: number | null; err: unknown; confirmationStatus?: string },
  blockHeight: 100,
}));

vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/owner-portfolio", () => ({ findOwnerPortfolio: vi.fn(async () => (m.portfolioFound ? PORTFOLIO : null)) }));
vi.mock("@/lib/v18-wire", async (orig) => ({ ...(await orig<typeof import("@/lib/v18-wire")>()), fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 7n, positionEpoch: 1n, matcherSequence: 3n })) }));
vi.mock("@/lib/v22/layout", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/layout")>()), parsePortfolio: () => m.pf }));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/decode")>()),
  decodePortfolioRisk: () => ({ capital: 1_000_000_000n, pnl: 0n, feeCredits: 0n }),
  signedPositionForAsset: () => m.position,
}));
// The open-order guards (stale oracle, per-side size cap) read market + matcher + LP: tested on real fixtures in guards.test.ts.
vi.mock("@/lib/bot-api/builders/caps", async (orig) => ({
  ...(await orig<typeof import("@/lib/bot-api/builders/caps")>()),
  checkOpenMarketGuards: async (_c: unknown, p: { reducing: boolean }) => {
    if (!p.reducing) {
      m.guards++;
      if (m.guardThrow) throw m.guardThrow;
    }
    return { expectedFeeBps: 65, expectedFeeAtoms: 130_000n };
  },
}));
vi.mock("@/lib/slab-max-leverage", () => ({ maxLeverageFromSlab: () => 20 }));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  getPriorityFee: vi.fn(async () => 1000),
  simulateForGate: vi.fn(async (_c: unknown, _p: unknown, ixs: TransactionInstruction[]) => ({ err: m.gate.err, logs: m.gate.logs, consumed: m.gate.err ? null : 90_000, rpcFailed: false, simulated: ixs })),
}));
vi.mock("@/lib/v22/trade-build", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/trade-build")>();
  return {
    ...real,
    // The effective-position rule has its own real-fixture tests (adl-close.test.ts); here the position is the scenario's.
    effectiveTakerPosition: () => ({ q: m.position, reset: false }),
    buildV22Trade: vi.fn(async (_c: unknown, req: import("@/lib/v22/trade-build").TradeBuildRequest) => {
      m.buildCalls++;
      if (m.buildThrow) throw m.buildThrow;
      await req.preflight?.({
        size: req.size,
        limitPriceE6: req.limitPriceE6 ?? 2_020_000n,
        effectivePriceE6: m.pre.effectivePriceE6,
        positionBeforeQ: m.pre.positionBeforeQ,
        positionLegReset: false,
        reducing: m.pre.reducing,
        marketData: new Uint8Array(MARKET_DATA),
        portfolioData: new Uint8Array(1),
        programId: WRAPPER,
        market: req.slab,
        lp: { accountB: Keypair.generate().publicKey, matcherCtx: Keypair.generate().publicKey },
      });
      const tx = new Transaction();
      tx.add(SystemProgram.transfer({ fromPubkey: req.owner, toPubkey: req.slab, lamports: 1 + m.buildCalls }));
      tx.feePayer = req.owner;
      tx.recentBlockhash = BH;
      return {
        transactions: [{ purpose: m.resubmit ? "crank" : "order", transaction: tx, computeUnitLimit: 800_000, unitsConsumed: 300_000 }],
        resubmitAfter: m.resubmit,
        blockhash: BH,
        lastValidBlockHeight: 4242,
        summary: { market: req.slab.toBase58(), size: req.size.toString(), limitPriceE6: String(req.limitPriceE6 ?? 2_020_000n), reducing: m.pre.reducing },
      };
    }),
  };
});
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async (k: PublicKey) => {
      if (k.equals(SLAB)) return { owner: WRAPPER, data: MARKET_DATA, lamports: 1, executable: false };
      if (k.equals(PORTFOLIO)) return { owner: WRAPPER, data: Buffer.alloc(64), lamports: 1, executable: false };
      if (k.toBase58() === m.fresh) return m.newPortfolioExists ? { owner: WRAPPER, data: Buffer.alloc(8), lamports: 1, executable: false } : null;
      if (m.ataBalance !== null) {
        // any other key read here is the owner's collateral ATA
        const d = Buffer.alloc(165);
        d.writeBigUInt64LE(m.ataBalance, 64);
        return { owner: WRAPPER, data: d, lamports: 1, executable: false };
      }
      return null;
    },
    simulateTransaction: async (tx: VersionedTransaction, opts: { sigVerify: boolean; replaceRecentBlockhash: boolean }) => {
      expect(opts).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
      m.simTxs.push(tx);
      const s = m.finalSims.shift() ?? { err: null };
      return { context: { slot: 1 }, value: { err: s.err, logs: s.logs ?? ["Program log: ok"], unitsConsumed: s.err ? 0 : 301_000 } };
    },
    getLatestBlockhash: async () => ({ blockhash: BH, lastValidBlockHeight: 5151 }),
    getMinimumBalanceForRentExemption: async () => 9_999_999,
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [m.sigStatus] }),
    getBlockHeight: async () => m.blockHeight,
  }),
}));

import { MemoryKv, __setKvForTest } from "@/lib/bot-api/kv";
import { issueKey } from "@/lib/bot-api/keys";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { TradeBuildRefusal } from "@/lib/v22/trade-build";
import { POST as orders } from "@/app/api/v1/orders/route";
import { POST as cancel } from "@/app/api/v1/orders/cancel/route";
import { POST as close } from "@/app/api/v1/positions/close/route";
import { POST as deposits } from "@/app/api/v1/deposits/route";
import { POST as withdrawals } from "@/app/api/v1/withdrawals/route";
import { GET as tx } from "@/app/api/v1/tx/[signature]/route";
import { buildOpenApi } from "@/lib/bot-api/openapi";
import { validate } from "../lib/bot-api/openapi-validate";

let key: string;
const post = (h: (r: NextRequest) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  h(new NextRequest(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "1.1.1.1", ...headers } }));
const order = (o: Record<string, unknown> = {}) => ({ owner: OWNER.toBase58(), market: SLAB.toBase58(), side: "buy", size: "1000000000", ...o });

beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("BOT_API_ENABLED", "1");
  vi.stubEnv("BOT_API_LOG", "0");
  __setDevnetV22ForTest(true);
  const kv = new MemoryKv();
  __setKvForTest(kv);
  key = (await issueKey({ scopes: ["read", "build"], tier: "mm" }, kv)).key;
  Object.assign(m, {
    pre: { effectivePriceE6: 2_000_000n, positionBeforeQ: 0n, reducing: false }, guards: 0, guardThrow: null,
    buildCalls: 0, buildThrow: null, resubmit: false, finalSims: [], simTxs: [], gate: { err: null, logs: [] }, portfolioFound: true,
    pf: { capital: 50_000_000n, legs: [], owner: OWNER, marketGroupId: SLAB }, ataBalance: 100_000_000n, newPortfolioExists: false, fresh: null, position: 0n, sigStatus: null, blockHeight: 100,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
  __setKvForTest(null);
});

describe("POST /api/v1/orders", () => {
  it("returns the unsigned tx, its blockhash and lastValidBlockHeight, and simulates exactly those bytes", async () => {
    const r = await post(orders, "/api/v1/orders", order());
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ blockhash: BH, lastValidBlockHeight: 4242, resubmitAfter: false, caps: { slippageBps: 100, maxNotionalUsd: 5000, maxLeverage: 10, notionalUsd: 2000, leverageAfter: 2, reduceOnly: false } });
    const t = b.transactions[0];
    expect(t).toMatchObject({ purpose: "order", signers: [OWNER.toBase58()], simulation: { unitsConsumed: 301_000 } });
    const sent = Transaction.from(Buffer.from(t.transaction, "base64"));
    expect(sent.signatures.every((s) => s.signature === null)).toBe(true);
    const msgBytes = sent.compileMessage().serialize();
    expect(createHash("sha256").update(msgBytes).digest("hex")).toBe(t.messageHash);
    // The final simulation ran on the same message the caller signs (blockhash included).
    expect(Buffer.from(m.simTxs[0].message.serialize()).equals(Buffer.from(msgBytes))).toBe(true);
    expect(m.simTxs[0].message.recentBlockhash).toBe(BH);
  });
  it("sell maps to a negative size; default slippage 100 bps is passed to the builder", async () => {
    const r = await post(orders, "/api/v1/orders", order({ side: "sell" }));
    const b = await r.json();
    expect(b.summary).toMatchObject({ side: "sell", size: "-1000000000" });
  });
  it("strict body: unknown field, number size, bad side, slippage > 1000, both limit and slippage", async () => {
    const codeOf = async (o: Record<string, unknown>) => (await (await post(orders, "/api/v1/orders", order(o))).json()).error.code;
    expect(await codeOf({ reduce_only: true })).toBe("bad_request");
    expect(await codeOf({ size: 1000 })).toBe("bad_request");
    expect(await codeOf({ side: "long" })).toBe("bad_request");
    expect(await codeOf({ size: "0" })).toBe("bad_request");
    expect(await codeOf({ slippageBps: 1001 })).toBe("slippage_cap_exceeded");
    expect(await codeOf({ slippageBps: 50, limitPriceE6: "100" })).toBe("bad_request");
    expect(m.buildCalls).toBe(0);
  });
  it("caps refuse before anything is simulated", async () => {
    const r = await post(orders, "/api/v1/orders", order({ size: "3000000000" }));
    expect((await r.json()).error.code).toBe("notional_cap_exceeded");
    const l = await post(orders, "/api/v1/orders", order({ maxLeverage: 1.5 }));
    expect((await l.json()).error).toMatchObject({ code: "leverage_cap_exceeded", details: { cap: 1.5 } });
    m.pre.positionBeforeQ = 5n;
    const ro = await post(orders, "/api/v1/orders", order({ reduceOnly: true }));
    expect((await ro.json()).error.code).toBe("reduce_only_violation");
    expect(m.simTxs).toHaveLength(0);
  });
  it("clerk F2/F3: opens run the market guards (stale oracle, size cap) before simulating; reducing orders and closes never do", async () => {
    const { ApiError } = await import("@/lib/bot-api/errors");
    m.guardThrow = new ApiError("market_stale");
    const stale = await post(orders, "/api/v1/orders", order());
    expect([stale.status, (await stale.json()).error.code]).toEqual([409, "market_stale"]);
    m.guardThrow = new ApiError("size_cap_exceeded");
    expect((await (await post(orders, "/api/v1/orders", order())).json()).error.code).toBe("size_cap_exceeded");
    expect(m.simTxs).toHaveLength(0);
    // a reducing order and a close go through even with a stale oracle
    m.position = 7_000_000n;
    m.pre = { effectivePriceE6: 2_000_000n, positionBeforeQ: 7_000_000n, reducing: true };
    expect((await post(orders, "/api/v1/orders", order({ side: "sell", size: "1000000", reduceOnly: true }))).status).toBe(200);
    expect((await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58() })).status).toBe(200);
  });
  it("first-timer F3: no_portfolio points at POST /deposits with newPortfolio and says trading account", async () => {
    m.buildThrow = new TradeBuildRefusal("no_portfolio", "owner has no portfolio on this market; deposit in the app first", 409);
    const e = (await (await post(orders, "/api/v1/orders", order())).json()).error;
    expect(e.code).toBe("no_portfolio");
    expect(e.message).toContain("trading account");
    expect(e.message).toContain("POST /api/v1/deposits");
    expect(e.message).toContain("newPortfolio");
    expect(e.message).not.toContain("in the app");
    expect(e.details).toMatchObject({ next: "POST /api/v1/deposits" });
    m.portfolioFound = false;
    const w = (await (await post(withdrawals, "/api/v1/withdrawals", { owner: OWNER.toBase58(), market: SLAB.toBase58(), amount: "1" })).json()).error;
    expect(w.details).toMatchObject({ next: "POST /api/v1/deposits" });
  });
  it("a failed final simulation is refused with the decoded on-chain code; BlockhashNotFound is retryable", async () => {
    m.finalSims = [{ err: { InstructionError: [3, { Custom: 49 }] }, logs: ["Program log: margin"] }];
    const r = await post(orders, "/api/v1/orders", order());
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatchObject({ code: "insufficient_margin", onchain: { code: 49, name: "EngineInsufficientInitialMargin" }, logs: ["Program log: margin"] });
    m.finalSims = [{ err: "BlockhashNotFound" }];
    const b = await post(orders, "/api/v1/orders", order());
    expect(b.status).toBe(503);
    expect((await b.json()).error).toMatchObject({ code: "rpc_unavailable", retryable: true });
  });
  it("builder refusals keep their meaning", async () => {
    m.buildThrow = new TradeBuildRefusal("fee_raise_required", "the market now needs a 160 bps fee cap", 409);
    expect((await (await post(orders, "/api/v1/orders", order())).json()).error.code).toBe("fee_raise_required");
    m.buildThrow = new TradeBuildRefusal("simulation_failed", 'Transaction simulation failed: {"InstructionError":[3,{"Custom":27}]}', 422, ["l1"]);
    expect((await (await post(orders, "/api/v1/orders", order())).json()).error).toMatchObject({ code: "market_stale", onchain: { code: 27, name: "OracleStale" } });
    m.buildThrow = new TradeBuildRefusal("no_portfolio", "owner has no portfolio", 409);
    expect((await (await post(orders, "/api/v1/orders", order())).json()).error.code).toBe("no_portfolio");
    m.buildThrow = new Error("raw rpc text https://secret.example/?api-key=abc");
    const x = await post(orders, "/api/v1/orders", order());
    expect(JSON.stringify(await x.json())).not.toContain("secret");
  });
  it("Idempotency-Key: a retry returns byte-identical txs without a second build; cancel stops further replays", async () => {
    const h = { "idempotency-key": "bot-ord-0001" };
    const a = await (await post(orders, "/api/v1/orders", order(), h)).json();
    const b = await (await post(orders, "/api/v1/orders", order(), h)).json();
    expect(b.transactions[0].transaction).toBe(a.transactions[0].transaction);
    expect(m.buildCalls).toBe(1);
    const c = await post(cancel, "/api/v1/orders/cancel", { idempotencyKey: "bot-ord-0001" });
    expect(await c.json()).toMatchObject({ cancelled: true, alreadyCancelled: false, lastValidBlockHeight: 4242 });
    const d = await post(orders, "/api/v1/orders", order(), h);
    expect(d.status).toBe(409);
    expect((await d.json()).error.code).toBe("order_cancelled");
    expect((await post(cancel, "/api/v1/orders/cancel", { idempotencyKey: "never-sent-1" })).status).toBe(404);
  });
});

describe("POST /api/v1/positions/close", () => {
  it("closes the whole position reduce-only (opposite side, exact size)", async () => {
    m.position = 7_000_000n;
    m.pre = { effectivePriceE6: 2_000_000n, positionBeforeQ: 7_000_000n, reducing: true };
    const r = await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58() });
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.summary.size).toBe("-7000000");
    expect(b.caps.reduceOnly).toBe(true);
  });
  it("partial close, oversize refused, no position refused", async () => {
    m.position = -7_000_000n;
    m.pre = { effectivePriceE6: 2_000_000n, positionBeforeQ: -7_000_000n, reducing: true };
    const p = await (await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58(), size: "2000000" })).json();
    expect(p.summary.size).toBe("2000000");
    const o = await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58(), size: "8000000" });
    expect((await o.json()).error.code).toBe("reduce_only_violation");
    m.position = 0n;
    expect((await (await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58() })).json()).error.code).toBe("no_position");
  });
  it("a position that changed under the close is refused by the builder's reduce-only check", async () => {
    m.position = 7_000_000n;
    m.pre = { effectivePriceE6: 2_000_000n, positionBeforeQ: 0n, reducing: false };
    expect((await (await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58() })).json()).error.code).toBe("no_position");
  });
});

describe("contract: builder JSON fits the OpenAPI schemas", () => {
  const schemas = (buildOpenApi() as unknown as { components: { schemas: Record<string, Record<string, unknown>> } }).components.schemas;
  const fits = (name: string, body: unknown) => expect(validate(schemas[name], body, schemas), name).toEqual([]);
  it("orders, close, deposits (both shapes), withdrawals and an error answer", async () => {
    const o = await (await post(orders, "/api/v1/orders", order())).json();
    fits("BuildResponse", o);
    expect(o.summary).toMatchObject({ side: "buy", feeCapBps: null, expectedFeeBps: 65, expectedFeeAtoms: "130000" });
    expect(o.summary).not.toHaveProperty("feeBps");
    m.position = 7_000_000n;
    m.pre = { effectivePriceE6: 2_000_000n, positionBeforeQ: 7_000_000n, reducing: true };
    fits("BuildResponse", await (await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58() })).json());
    fits("BuildResponse", await (await post(deposits, "/api/v1/deposits", { owner: OWNER.toBase58(), market: SLAB.toBase58(), amount: "25000000" })).json());
    fits("BuildResponse", await (await post(withdrawals, "/api/v1/withdrawals", { owner: OWNER.toBase58(), market: SLAB.toBase58(), amount: "25000000" })).json());
    fits("ErrorEnvelope", await (await post(orders, "/api/v1/orders", order({ size: "0" }))).json());
  });
  it("first-timer F7: a negative size is refused, and the spec's pattern agrees", async () => {
    const r = await post(orders, "/api/v1/orders", order({ size: "-1000000" }));
    expect(r.status).toBe(400);
    expect(validate(schemas.OrderRequest, order({ size: "-1000000" }), schemas).join()).toContain("size");
    expect(validate(schemas.OrderRequest, order(), schemas)).toEqual([]);
  });
  it("trader (c): slippageBps 0 is refused before anything is built, and the spec's minimum agrees", async () => {
    const r = await post(orders, "/api/v1/orders", order({ slippageBps: 0 }));
    expect([r.status, (await r.json()).error.code]).toEqual([400, "bad_request"]);
    expect(m.buildCalls).toBe(0);
    expect(validate(schemas.OrderRequest, order({ slippageBps: 0 }), schemas).join()).toContain("slippageBps");
    const c = await post(close, "/api/v1/positions/close", { owner: OWNER.toBase58(), market: SLAB.toBase58(), slippageBps: 0 });
    expect(c.status).toBe(400);
  });
});

describe("POST /api/v1/deposits and /api/v1/withdrawals", () => {
  const dep = (o: Record<string, unknown> = {}) => ({ owner: OWNER.toBase58(), market: SLAB.toBase58(), amount: "25000000", ...o });
  it("existing account: one Deposit, owner the only signer, simulated on its bytes", async () => {
    const r = await post(deposits, "/api/v1/deposits", dep());
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.summary).toMatchObject({ created: false, portfolio: PORTFOLIO.toBase58(), amount: "25000000" });
    expect(b.transactions[0].signers).toEqual([OWNER.toBase58()]);
    expect(b.lastValidBlockHeight).toBe(5151);
    expect(m.simTxs).toHaveLength(1);
  });
  it("no account: needs newPortfolio, then create + init + deposit in one tx co-signed by newPortfolio", async () => {
    m.portfolioFound = false;
    const a = await post(deposits, "/api/v1/deposits", dep());
    expect((await a.json()).error.code).toBe("no_portfolio");
    const fresh = Keypair.generate().publicKey;
    m.fresh = fresh.toBase58();
    m.newPortfolioExists = true;
    expect((await (await post(deposits, "/api/v1/deposits", dep({ newPortfolio: fresh.toBase58() }))).json()).error.message).toContain("already exists");
    m.newPortfolioExists = false;
    const r = await post(deposits, "/api/v1/deposits", dep({ newPortfolio: fresh.toBase58() }));
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.summary).toMatchObject({ created: true, portfolio: fresh.toBase58() });
    expect(b.transactions[0].signers).toEqual([OWNER.toBase58(), fresh.toBase58()]);
  });
  it("refuses more than the wallet holds, and a gate simulation failure with its code", async () => {
    m.ataBalance = 1n;
    expect((await (await post(deposits, "/api/v1/deposits", dep())).json()).error.code).toBe("insufficient_funds");
    m.ataBalance = 100_000_000n;
    m.gate = { err: { InstructionError: [3, { Custom: 27 }] }, logs: [] };
    expect((await (await post(deposits, "/api/v1/deposits", dep())).json()).error.code).toBe("market_stale");
  });
  it("withdraw: refused with an open position or above capital; otherwise one tx with an idempotent ATA create", async () => {
    m.pf.legs = [{ active: true }];
    expect((await (await post(withdrawals, "/api/v1/withdrawals", dep())).json()).error).toMatchObject({ code: "insufficient_funds", details: { reason: "position_open" } });
    m.pf.legs = [];
    expect((await (await post(withdrawals, "/api/v1/withdrawals", dep({ amount: "60000000" }))).json()).error.code).toBe("insufficient_funds");
    const r = await post(withdrawals, "/api/v1/withdrawals", dep());
    const b = await r.json();
    expect(r.status).toBe(200);
    const t = Transaction.from(Buffer.from(b.transactions[0].transaction, "base64"));
    expect(t.instructions.filter((ix) => ix.programId.equals(WRAPPER))).toHaveLength(1);
    expect(b.transactions[0].signers).toEqual([OWNER.toBase58()]);
  });
  it("a portfolio that is not this owner's on this market is refused", async () => {
    m.pf.owner = Keypair.generate().publicKey;
    expect((await (await post(withdrawals, "/api/v1/withdrawals", dep())).json()).error.code).toBe("bad_portfolio");
  });
});

describe("GET /api/v1/tx/{signature}", () => {
  const sig = "5".repeat(87) + "1";
  const get = (s: string, q = "") => tx(new NextRequest(`http://x/api/v1/tx/${s}${q}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ signature: s }) });
  it("pending / expired / unknown when not seen", async () => {
    const realSig = "2" + "1".repeat(86) + "2";
    expect((await (await get(realSig, "?lastValidBlockHeight=200")).json()).status).toBe("pending");
    m.blockHeight = 201;
    expect((await (await get(realSig, "?lastValidBlockHeight=200")).json()).status).toBe("expired");
    expect((await (await get(realSig)).json()).status).toBe("unknown");
  });
  it("confirmed, and failed with the decoded code", async () => {
    const s = "3" + "1".repeat(86) + "3";
    m.sigStatus = { slot: 9, confirmations: null, err: null, confirmationStatus: "finalized" };
    expect(await (await get(s)).json()).toMatchObject({ status: "finalized", slot: 9 });
    m.sigStatus = { slot: 9, confirmations: 1, err: { InstructionError: [3, { Custom: 49 }] }, confirmationStatus: "confirmed" };
    expect(await (await get(s)).json()).toMatchObject({ status: "failed", err: { onchain: { code: 49, name: "EngineInsufficientInitialMargin" } } });
  });
  it("refuses a malformed signature or height", async () => {
    expect((await get("notasig")).status).toBe(400);
    expect((await get(sig.slice(0, 40))).status).toBe(400);
    const s = "4" + "1".repeat(86) + "4";
    expect((await get(s, "?lastValidBlockHeight=-1")).status).toBe(400);
  });
});

// G13: the API's Deposit / Withdraw must be byte-identical to what the app's hooks send for the same account
// (hooks/useDeposit.ts:240-256, hooks/useWithdraw.ts:388-402), so a bot and the UI hit the program the same way.
describe("builder / hook parity", () => {
  const dep = (o: Record<string, unknown> = {}) => ({ owner: OWNER.toBase58(), market: SLAB.toBase58(), amount: "25000000", ...o });
  const wrapperIx = (b: { transactions: { transaction: string }[] }) => {
    const ixs = Transaction.from(Buffer.from(b.transactions[0].transaction, "base64")).instructions.filter((ix) => ix.programId.equals(WRAPPER));
    expect(ixs).toHaveLength(1);
    return ixs[0];
  };
  const same = (a: TransactionInstruction, b: TransactionInstruction) => {
    expect(a.programId.toBase58()).toBe(b.programId.toBase58());
    expect(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
    expect(Buffer.from(a.data).toString("hex")).toBe(Buffer.from(b.data).toString("hex"));
  };
  const accounts = async () => {
    const sdk = await import("@percolatorct/sdk");
    const mint = sdk.parseWrapperConfigV17(new Uint8Array(MARKET_DATA), sdk.V17_HEADER_LEN).collateralMint;
    const [vaultPda] = sdk.deriveVaultAuthority(WRAPPER, SLAB);
    return { sdk, vaultPda, userAta: await sdk.getAta(OWNER, mint), vaultTokenAta: await sdk.getAta(vaultPda, mint, true) };
  };

  it("deposit into an existing account matches useDeposit's v18 Deposit", async () => {
    const r = await post(deposits, "/api/v1/deposits", dep());
    expect(r.status).toBe(200);
    const { sdk, userAta, vaultTokenAta } = await accounts();
    // fetchPortfolioIdentity is mocked above: portfolioId 7, matcherSequence 3 (what the hook would read live).
    const hook = sdk.buildIx({
      programId: WRAPPER,
      keys: sdk.buildAccountMetas(sdk.ACCOUNTS_DEPOSIT_COLLATERAL, [OWNER, SLAB, PORTFOLIO, userAta, vaultTokenAta, sdk.WELL_KNOWN.tokenProgram]),
      data: sdk.encodeDepositCollateral({ portfolioId: 7n, expectedSequence: 3n, amount: "25000000" }),
    });
    same(wrapperIx(await r.json()), hook);
  });

  it("withdraw matches useWithdraw's v18 WithdrawCollateral", async () => {
    const r = await post(withdrawals, "/api/v1/withdrawals", dep());
    expect(r.status).toBe(200);
    const { sdk, vaultPda, userAta, vaultTokenAta } = await accounts();
    const hook = sdk.buildIx({
      programId: WRAPPER,
      keys: sdk.buildAccountMetas(sdk.ACCOUNTS_WITHDRAW_COLLATERAL, [OWNER, SLAB, PORTFOLIO, userAta, vaultTokenAta, vaultPda, sdk.WELL_KNOWN.tokenProgram]),
      data: sdk.encodeWithdrawCollateral({ portfolioId: 7n, expectedSequence: 3n, amount: "25000000" }),
    });
    same(wrapperIx(await r.json()), hook);
  });
});
