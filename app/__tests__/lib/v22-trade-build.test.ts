// @vitest-environment node
/**
 * lib/v22/trade-build.ts: the server builder for POST /api/v22/trade.
 * Market bytes are a real devnet v2.2 market (fixture); account resolution, identity reads and simulation are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";

const fx = JSON.parse(readFileSync(join(__dirname, "../fixtures/v22-trade-build/gato-market.json"), "utf8")) as { slab: string; owner: string; data: string };
const WRAPPER = new PublicKey(fx.owner);
const SLAB = new PublicKey(fx.slab);
const MARKET_DATA = Buffer.from(fx.data, "base64");

const pk = () => Keypair.generate().publicKey;
const OWNER = pk();
const PORTFOLIO = pk();
const LP = { accountB: pk(), matcherProg: pk(), matcherCtx: pk(), matcherDelegate: pk() };

const m = vi.hoisted(() => ({
  sims: [] as Array<{ err: unknown; logs?: string[]; consumed?: number | null; rpcFailed?: boolean }>,
  simCalls: [] as TransactionInstruction[][],
  fee: 135n as bigint | undefined,
  raisedFee: 160n as bigint | undefined,
  portfolio: null as PublicKey | null,
  crankPlan: "none" as "none" | "bundle" | "separate-tx",
  refreshPeers: 0,
  heal: null as null | { outcome: string; instructions: TransactionInstruction[] },
  slots: null as number | null,
}));
vi.mock("@/lib/v22/trade-refresh", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/trade-refresh")>();
  return { ...real, marketAssetSlots: (d: Uint8Array) => m.slots ?? real.marketAssetSlots(d) };
});

vi.mock("@/lib/programAllowlist", () => ({
  assertKnownProgram: (p: PublicKey) => {
    if (!p.equals(new PublicKey(JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "../fixtures/v22-trade-build/gato-market.json"), "utf8")).owner))) throw new Error("unknown");
  },
}));
vi.mock("@/lib/v22/trade-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-accounts")>()),
  resolveLpTradeAccounts: vi.fn(async () => LP),
}));
vi.mock("@/lib/owner-portfolio", () => ({ findOwnerPortfolio: vi.fn(async () => m.portfolio) }));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...(await orig<typeof import("@/lib/v18-wire")>()),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 7n, positionEpoch: 1n, matcherSequence: 3n })),
  fetchAssetMarketId: vi.fn(async () => 11n),
}));
vi.mock("@/lib/limits/trade-fee-resolve", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/trade-fee-resolve")>()),
  fetchTradeFeeBps: vi.fn(async (_c: unknown, _m: unknown, _x: unknown, p: { withUtilMax?: boolean }) => (p.withUtilMax ? m.raisedFee : m.fee)),
}));
vi.mock("@/lib/v22/lev-guard", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/lev-guard")>()), levGuardExists: vi.fn(async () => false) }));
vi.mock("@/lib/position-change", () => ({ readBeforeTradeFull: vi.fn(async () => null) }));
vi.mock("@/lib/taker-crank", () => ({ planTakerCrank: vi.fn(async () => m.crankPlan) }));
vi.mock("@/lib/v22/trade-refresh-wire", () => ({
  planTradeRefresh: vi.fn(async (_c: unknown, i: { body: TransactionInstruction[] }) => ({
    path: "simple",
    instructions: [...Array.from({ length: m.refreshPeers }, () => ({ programId: WRAPPER, keys: [], data: Buffer.alloc(40, 5) }) as unknown as TransactionInstruction), ...i.body],
    cranks: Array.from({ length: m.refreshPeers }, () => ({ role: "peer", portfolio: PORTFOLIO })),
    rounds: 1,
  })),
}));
vi.mock("@/lib/self-heal", () => ({
  isSelfHealEnabled: () => true,
  connectionSelfHealDeps: () => ({}),
  planSelfHeal: vi.fn(async (p: { instructions: TransactionInstruction[]; computeUnits: number }) =>
    m.heal ? { ...m.heal, computeUnits: p.computeUnits, repairs: [{ kind: "expire-bucket" }] } : { outcome: "not-repairable", instructions: p.instructions, computeUnits: p.computeUnits, repairs: [] }),
}));
vi.mock("@/lib/tx", async (orig) => {
  const real = await orig<typeof import("@/lib/tx")>();
  return {
    ...real,
    getPriorityFee: vi.fn(async () => 1000),
    simulateForGate: vi.fn(async (_c: unknown, _p: unknown, ixs: TransactionInstruction[]) => {
      m.simCalls.push(ixs);
      const s = m.sims.shift() ?? { err: null, consumed: 280_000 };
      return { err: s.err ?? null, logs: s.logs ?? [], consumed: s.err ? null : (s.consumed ?? 280_000), rpcFailed: s.rpcFailed ?? false, simulated: ixs };
    }),
  };
});

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { buildV22Trade, TradeBuildRefusal, __clearTradeBuildCacheForTest } from "@/lib/v22/trade-build";
import { resolveLpTradeAccounts } from "@/lib/v22/trade-accounts";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";
import * as layout from "@/lib/v22/layout";
import { buildTradeIxs } from "@/lib/trade-ix";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { limitFromEngine } from "@/lib/close-limit";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

function conn(over: Partial<{ market: { owner: PublicKey; data: Buffer } | null; portfolio: Buffer | null }> = {}) {
  const market = over.market === undefined ? { owner: WRAPPER, data: MARKET_DATA } : over.market;
  return {
    getAccountInfo: vi.fn(async (k: PublicKey) => {
      if (k.equals(SLAB)) return market ? { owner: market.owner, data: market.data, lamports: 1, executable: false } : null;
      if (k.equals(PORTFOLIO)) return over.portfolio ? { owner: WRAPPER, data: over.portfolio, lamports: 1, executable: false } : null;
      return null;
    }),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 })),
  } as unknown as import("@solana/web3.js").Connection;
}

async function refusal(p: Promise<unknown>): Promise<TradeBuildRefusal> {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(TradeBuildRefusal);
  return e as TradeBuildRefusal;
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  m.sims = [];
  m.simCalls = [];
  m.fee = 135n;
  m.raisedFee = 160n;
  m.portfolio = PORTFOLIO;
  m.crankPlan = "none";
  m.refreshPeers = 0;
  m.heal = null;
  m.slots = null;
  __clearTradeBuildCacheForTest();
  vi.mocked(resolveLpTradeAccounts).mockClear();
  vi.mocked(findOwnerPortfolio).mockClear();
});
afterEach(() => __setDevnetV22ForTest(null));

describe("buildV22Trade", () => {
  it("TradeCpi wiring: same bytes/keys as buildTradeIxs with the engine-price limit, resolved fee and identities; owner is the only signer", async () => {
    const size = 3_000_000n;
    const r = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size });
    expect(r.resubmitAfter).toBe(false);
    expect(r.transactions).toHaveLength(1);
    const t = r.transactions[0];
    expect(t.purpose).toBe("order");
    expect(t.transaction.feePayer?.equals(OWNER)).toBe(true);
    expect(t.transaction.signatures.every((s) => s.signature === null)).toBe(true);
    const msg = t.transaction.compileMessage();
    expect(msg.header.numRequiredSignatures).toBe(1);
    expect(msg.accountKeys[0].equals(OWNER)).toBe(true);

    const engine = decodeMarketEngineView(new Uint8Array(MARKET_DATA));
    const limit = limitFromEngine(engine, size);
    expect(r.summary.limitPriceE6).toBe(limit.toString());
    const expected = buildTradeIxs({
      levGuard: false, programId: WRAPPER, signer: OWNER, market: SLAB, accountA: PORTFOLIO, ...LP,
      takerId: { portfolioId: 7n, positionEpoch: 1n }, lpId: { portfolioId: 7n, positionEpoch: 1n, matcherSequence: 3n },
      marketId: 11n, legs: [size], size, limitPriceE6: limit, feeBps: 135n, marketTradeFeeBps: parseWrapperConfigV17(new Uint8Array(MARKET_DATA), V17_HEADER_LEN).tradeFeeBps,
    });
    // [heap frame, CU limit, CU price, ...order]; compare the wrapper instruction(s) by program, keys and data.
    const body = t.transaction.instructions.slice(3).filter((ix) => ix.programId.equals(WRAPPER));
    expect(body).toHaveLength(expected.length);
    body.forEach((ix, i) => {
      expect(Buffer.from(ix.data).toString("hex")).toBe(Buffer.from(expected[i].data).toString("hex"));
      expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(expected[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
    });
    expect(t.computeUnitLimit).toBeGreaterThanOrEqual(800_000); // v2.2 signed floor, as the app
  });

  it("uses the caller's slippage around the engine price, and an explicit limit as given", async () => {
    const eff = decodeMarketEngineView(new Uint8Array(MARKET_DATA))!.effectivePriceE6;
    const a = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n, slippageBps: 100n });
    expect(BigInt(a.summary.limitPriceE6)).toBe((eff * 10_100n + 9_999n) / 10_000n);
    const b = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: -1_000_000n, limitPriceE6: 42n });
    expect(b.summary.limitPriceE6).toBe("42");
  });

  it("refuses a zero limit (it switches the on-chain slippage check off) and a zero size", async () => {
    expect((await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1n, limitPriceE6: 0n }))).code).toBe("bad_limit");
    expect((await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 0n }))).code).toBe("bad_size");
  });

  it("refuses a missing market, a market of an unknown program and a non-v2.2 account", async () => {
    expect((await refusal(buildV22Trade(conn({ market: null }), { owner: OWNER, slab: SLAB, size: 1n }))).status).toBe(404);
    expect((await refusal(buildV22Trade(conn({ market: { owner: pk(), data: MARKET_DATA } }), { owner: OWNER, slab: SLAB, size: 1n }))).code).toBe("unknown_program");
    expect((await refusal(buildV22Trade(conn({ market: { owner: WRAPPER, data: Buffer.alloc(4059) } }), { owner: OWNER, slab: SLAB, size: 1n }))).code).toBe("not_v22");
  });

  it("refuses an owner without a taker portfolio (409), nothing simulated", async () => {
    m.portfolio = null;
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }));
    expect([e.code, e.status]).toEqual(["no_portfolio", 409]);
    expect(m.simCalls).toHaveLength(0);
  });

  it("refuses when the market's fee cap is above maxFeeBps, before simulating", async () => {
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n, maxFeeBps: 100n }));
    expect(e.code).toBe("fee_above_max");
    expect(m.simCalls).toHaveLength(0);
  });

  it("refuses when the fee terms are unreadable (strict), never signs a guessed fee", async () => {
    const { fetchTradeFeeBps } = await import("@/lib/limits/trade-fee-resolve");
    vi.mocked(fetchTradeFeeBps).mockRejectedValueOnce(new Error("rpc down"));
    expect((await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }))).code).toBe("fee_unreadable");
  });

  it("98 without maxFeeBps: refused with the new cap (no silent raise)", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 98 }] } }];
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }));
    expect([e.code, e.status]).toEqual(["fee_raise_required", 409]);
    expect(e.message).toContain("160");
  });

  it("98 with maxFeeBps: rebuilds once with the utilisation maximum, and refuses if that is above maxFeeBps", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 98 }] } }, { err: null }];
    const r = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n, maxFeeBps: 200n });
    expect(r.summary.feeBps).toBe("160");
    expect(r.summary.repairs).toEqual(["fee-cap-raised:160"]);

    m.sims = [{ err: { InstructionError: [3, { Custom: 98 }] } }];
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n, maxFeeBps: 150n }));
    expect(e.code).toBe("fee_above_max");
  });

  it("an RPC failure on ANY re-simulation is a 503, never a returned tx", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 98 }] } }, { err: null, rpcFailed: true }];
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n, maxFeeBps: 200n }));
    expect([e.code, e.status]).toEqual(["rpc", 503]);
    m.sims = [{ err: { InstructionError: [3, { Custom: 19 }] } }, { err: null, rpcFailed: true }];
    m.heal = { outcome: "repaired", instructions: [{ programId: WRAPPER, keys: [], data: Buffer.from([89]) } as unknown as TransactionInstruction] };
    expect((await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }))).code).toBe("rpc");
  });

  it("refuses a multi-asset market (not covered yet), nothing simulated", async () => {
    m.slots = 2;
    expect((await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }))).code).toBe("multi_asset_unsupported");
    expect(m.simCalls).toHaveLength(0);
  });

  it("resolves the LP once per market within the TTL", async () => {
    await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n });
    await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: -1_000_000n });
    expect(vi.mocked(resolveLpTradeAccounts)).toHaveBeenCalledTimes(1);
  });

  it("a caller-named portfolio skips the scan only when it is the owner's taker portfolio on this market", async () => {
    const good = { owner: OWNER, marketGroupId: SLAB, matcherEnabled: false, legs: [] };
    const spy = vi.spyOn(layout, "parsePortfolio");
    spy.mockReturnValue(good as unknown as ReturnType<typeof layout.parsePortfolio>);
    const r = await buildV22Trade(conn({ portfolio: Buffer.alloc(16) }), { owner: OWNER, slab: SLAB, size: 1_000_000n, portfolio: PORTFOLIO });
    expect(r.summary.portfolio).toBe(PORTFOLIO.toBase58());
    expect(vi.mocked(findOwnerPortfolio)).not.toHaveBeenCalled();
    for (const bad of [{ ...good, owner: pk() }, { ...good, marketGroupId: pk() }, { ...good, matcherEnabled: true }]) {
      spy.mockReturnValue(bad as unknown as ReturnType<typeof layout.parsePortfolio>);
      const e = await refusal(buildV22Trade(conn({ portfolio: Buffer.alloc(16) }), { owner: OWNER, slab: SLAB, size: 1_000_000n, portfolio: PORTFOLIO }));
      expect(e.code).toBe("bad_portfolio");
    }
    spy.mockRestore();
  });

  it("an order too large for one packet is refused before it is simulated (no misleading rpc error)", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 121 }] } }];
    m.refreshPeers = 40;
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }));
    expect(e.code).toBe("too_large");
    expect(m.simCalls).toHaveLength(1); // only the first (normal-size) simulation ran
  });

  it("a refused simulation evicts the cached LP so the next build re-resolves it", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 49 }] } }];
    await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }));
    await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n });
    expect(vi.mocked(resolveLpTradeAccounts)).toHaveBeenCalledTimes(2);
  });

  it("121: adds the stale peers' refresh cranks in front and re-simulates", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 121 }] } }, { err: null, consumed: 900_000 }];
    m.refreshPeers = 2;
    const r = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n });
    expect(r.summary.repairs).toEqual(["peer-refresh:2"]);
    expect(m.simCalls).toHaveLength(2);
    expect(m.simCalls[1].length).toBe(m.simCalls[0].length + 2);
  });

  it("returns the simulation refusal with its logs when nothing repairs it", async () => {
    m.sims = [{ err: { InstructionError: [3, { Custom: 49 }] }, logs: ["Program log: a", "Program log: b"] }];
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }));
    expect(e.code).toBe("simulation_failed");
    expect(e.logs).toEqual(["Program log: a", "Program log: b"]);
  });

  it("self-heal: a repair that simulates clean is returned; one that does not is a refusal", async () => {
    const extra = { programId: WRAPPER, keys: [], data: Buffer.from([89]) } as unknown as TransactionInstruction;
    m.sims = [{ err: { InstructionError: [3, { Custom: 19 }] } }, { err: null }];
    m.heal = { outcome: "repaired", instructions: [extra] };
    const r = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n });
    expect(r.summary.repairs).toEqual(["expire-bucket"]);
    m.sims = [{ err: { InstructionError: [3, { Custom: 19 }] } }, { err: { InstructionError: [4, { Custom: 19 }] } }];
    expect((await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }))).code).toBe("simulation_failed");
  });

  it("a taker that needs a maintenance crank first gets ONLY the crank and resubmitAfter", async () => {
    m.crankPlan = "separate-tx";
    const { parsePortfolio } = await import("@/lib/v22/layout");
    void parsePortfolio;
    // Any parseable portfolio with an active leg: reuse the planner's verdict, the bytes only gate whether it runs.
    const layout = await import("@/lib/v22/layout");
    const spy = vi.spyOn(layout, "parsePortfolio").mockReturnValue({ legs: [{ active: true }] } as unknown as ReturnType<typeof layout.parsePortfolio>);
    const r = await buildV22Trade(conn({ portfolio: Buffer.alloc(16) }), { owner: OWNER, slab: SLAB, size: 1_000_000n });
    spy.mockRestore();
    expect(r.resubmitAfter).toBe(true);
    expect(r.transactions.map((t) => t.purpose)).toEqual(["crank"]);
  });

  it("an RPC failure mid-build is a 503 rpc refusal, never a partial result", async () => {
    const { fetchAssetMarketId } = await import("@/lib/v18-wire");
    vi.mocked(fetchAssetMarketId).mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const e = await refusal(buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n }));
    expect([e.code, e.status]).toEqual(["rpc", 503]);
  });
});

describe("buildV22Trade preflight (bot API caps)", () => {
  it("runs once with the limit, effective price and position before anything is simulated; returns lastValidBlockHeight", async () => {
    const seen: unknown[] = [];
    const r = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 2_000_000n, slippageBps: 100n, preflight: (p) => void seen.push({ ...p, marketData: p.marketData.length }) });
    expect(seen).toHaveLength(1);
    const eff = decodeMarketEngineView(new Uint8Array(MARKET_DATA))!.effectivePriceE6;
    expect(seen[0]).toMatchObject({ size: 2_000_000n, effectivePriceE6: eff, limitPriceE6: BigInt(r.summary.limitPriceE6), marketData: MARKET_DATA.length, reducing: false });
    expect(r.lastValidBlockHeight).toBe(1);
    expect(r.blockhash).toBe("11111111111111111111111111111111");
  });
  it("a preflight throw comes out unchanged (not as an rpc refusal) and nothing is simulated", async () => {
    class Cap extends Error {}
    const e = await buildV22Trade(conn(), { owner: OWNER, slab: SLAB, size: 1_000_000n, preflight: () => { throw new Cap("over cap"); } }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(Cap);
    expect(m.simCalls).toHaveLength(0);
  });
});
