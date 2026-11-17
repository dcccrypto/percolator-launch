/**
 * Branch coverage for lib/launch-recovery.ts: the paths that decide "resume this launch" vs "start
 * over / refuse". A wrong answer here double-charges (a second InitMarket) or strands the rent of the
 * half-launched slab, so every refusal and every fall-through is pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { IX_TAG } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { INIT_MARKET_TAG, KEEPER_REGISTER_MEMO_FAMILY, MEMO_PROGRAM_ID } from "@/lib/keeper-register-memo";
import type { KeyStore } from "@/lib/keeper-register-client";
import {
  adoptRecoveredLaunch,
  applyRecoveredLaunch,
  decodeInitMarketData,
  pinSameBrowserResume,
  readCreationFromChain,
  readInitialMarginBps,
  recoverLaunchFromChain,
  unboundResumeValues,
  type RecoveredLaunch,
  type ResumableParams,
} from "@/lib/launch-recovery";

const k = () => Keypair.generate().publicKey;
const WRAPPER = k();
const CREATOR = k();
const STRANGER = k();
const SLAB = k();
const MINT = k();
const MEMO = `${KEEPER_REGISTER_MEMO_FAMILY}v2:abc`;

function initData(len = 219, margin = 1000n): Uint8Array {
  const d = new Uint8Array(len);
  d[0] = INIT_MARKET_TAG;
  new DataView(d.buffer).setUint16(1, 1, true);
  if (len >= 75) new DataView(d.buffer).setBigUint64(67, margin, true);
  return d;
}
type Ix = { programId: PublicKey; keys: PublicKey[]; data: Uint8Array };
function fakeTx(signer: PublicKey, ixs: Ix[], meta: unknown = { err: null }) {
  const keys: PublicKey[] = [signer];
  const idx = (p: PublicKey) => {
    let i = keys.findIndex((x) => x.equals(p));
    if (i < 0) { keys.push(p); i = keys.length - 1; }
    return i;
  };
  const compiledInstructions = ixs.map((ix) => ({ programIdIndex: idx(ix.programId), accountKeyIndexes: ix.keys.map(idx), data: Buffer.from(ix.data) }));
  return { meta, transaction: { message: { staticAccountKeys: keys, compiledInstructions } } } as never;
}
const init = (data = initData(), slab = SLAB): Ix => ({ programId: WRAPPER, keys: [CREATOR, slab, MINT], data });
const memo = (text = MEMO): Ix => ({ programId: MEMO_PROGRAM_ID, keys: [CREATOR], data: Buffer.from(text) });
const rawIx = (data: number[], keys: PublicKey[]): Ix => ({ programId: WRAPPER, keys, data: Uint8Array.from(data) });

function conn(txs: { sig: string; tx: unknown; err?: unknown }[]) {
  return {
    getSignaturesForAddress: vi.fn(async () => [...txs].reverse().map((t) => ({ signature: t.sig, err: t.err ?? null }))),
    getTransaction: vi.fn(async (sig: string) => txs.find((t) => t.sig === sig)?.tx ?? null),
  } as never;
}
const read = (c: unknown) => readCreationFromChain(c as never, SLAB.toBase58(), WRAPPER.toBase58());

describe("decodeInitMarketData length rule follows the v2.2 flag", () => {
  afterEach(() => __setDevnetV22ForTest(null));
  it("flag on: a longer (trailer) payload decodes; flag off: only exactly 219 bytes", () => {
    __setDevnetV22ForTest(true);
    expect(decodeInitMarketData(initData(260))?.initialMarginBps).toBe(1000n);
    expect(decodeInitMarketData(initData(218))).toBeNull();
    __setDevnetV22ForTest(false);
    expect(decodeInitMarketData(initData(260))).toBeNull();
    expect(decodeInitMarketData(initData(219))).not.toBeNull();
  });
});

describe("readCreationFromChain: what counts as 'the launch landed'", () => {
  beforeEach(() => __setDevnetV22ForTest(false));
  afterEach(() => __setDevnetV22ForTest(null));

  it("no signatures at all -> no-creation-tx (start over)", async () => {
    const c = { getSignaturesForAddress: vi.fn(async () => []), getTransaction: vi.fn() };
    expect(await read(c)).toEqual({ ok: false, reason: "no-creation-tx" });
  });

  it("history too long to reach the first signature -> no-creation-tx, never a guess", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, err: null }));
    const c = { getSignaturesForAddress: vi.fn(async () => page), getTransaction: vi.fn() };
    expect(await read(c)).toEqual({ ok: false, reason: "no-creation-tx" });
    expect(c.getSignaturesForAddress).toHaveBeenCalledTimes(5);
    expect(c.getTransaction).not.toHaveBeenCalled();
  });

  it("pages back through a full page to the oldest one", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `n${i}`, err: null }));
    const tx = fakeTx(CREATOR, [init(), memo()]);
    const getSignaturesForAddress = vi.fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ signature: "old", err: null }]);
    const getTransaction = vi.fn(async () => tx);
    const r = await read({ getSignaturesForAddress, getTransaction });
    expect(r.ok).toBe(true);
    expect(getSignaturesForAddress.mock.calls[1][1]).toMatchObject({ before: "n999" });
  });

  it("only failed signatures -> no-creation-tx", async () => {
    const c = conn([{ sig: "a", tx: fakeTx(CREATOR, []), err: { InstructionError: 1 } }]);
    expect(await read(c)).toEqual({ ok: false, reason: "no-creation-tx" });
  });

  it("a listed signature the RPC cannot return is 'rpc', not 'no memo'", async () => {
    const c = conn([{ sig: "a", tx: null }]);
    expect(await read(c)).toEqual({ ok: false, reason: "rpc" });
  });

  it("a thrown RPC error is 'rpc'", async () => {
    const c = { getSignaturesForAddress: vi.fn(async () => { throw new Error("boom"); }), getTransaction: vi.fn() };
    expect(await read(c)).toEqual({ ok: false, reason: "rpc" });
  });

  it("skips transactions with no meta or a failed meta", async () => {
    const c = conn([
      { sig: "nometa", tx: fakeTx(CREATOR, [init(), memo()], null) },
      { sig: "failed", tx: fakeTx(CREATOR, [init(), memo()], { err: { x: 1 } }) },
    ]);
    // neither counts: nothing was found, and no memo was seen
    expect(await read(c)).toEqual({ ok: false, reason: "no-memo" });
  });

  it("an InitMarket for another slab is not this market's creation", async () => {
    const c = conn([{ sig: "a", tx: fakeTx(CREATOR, [init(initData(), k()), memo()]) }]);
    expect(await read(c)).toEqual({ ok: false, reason: "no-memo" });
  });

  it("an InitMarket carrying no collateral-mint account is not a creation", async () => {
    const noMint: Ix = { programId: WRAPPER, keys: [CREATOR, SLAB], data: initData() };
    expect(await read(conn([{ sig: "a", tx: fakeTx(CREATOR, [noMint, memo()]) }]))).toEqual({ ok: false, reason: "no-memo" });
  });

  it("an InitMarket with undecodable data is not a creation", async () => {
    const c = conn([{ sig: "a", tx: fakeTx(CREATOR, [init(initData(50)), memo()]) }]);
    expect(await read(c)).toEqual({ ok: false, reason: "no-memo" });
  });

  it("InitMarket without a registration memo -> no-memo; two memos -> several-memos", async () => {
    expect(await read(conn([{ sig: "a", tx: fakeTx(CREATOR, [init()]) }]))).toEqual({ ok: false, reason: "no-memo" });
    expect(await read(conn([{ sig: "a", tx: fakeTx(CREATOR, [init(), memo(), memo(`${MEMO}2`)]) }]))).toEqual({ ok: false, reason: "several-memos" });
  });

  it("a memo from another family is ignored", async () => {
    expect(await read(conn([{ sig: "a", tx: fakeTx(CREATOR, [init(), memo("hello")]) }]))).toEqual({ ok: false, reason: "no-memo" });
  });

  it("seed kinds: junior tranche beats everything; foreign deposits never make a creator-lp launch", async () => {
    const jt = new Uint8Array(17); jt[0] = 96; new DataView(jt.buffer).setBigUint64(1, 7n, true);
    const dep = (owner: PublicKey, amount: bigint) => {
      const d = new Uint8Array(33); d[0] = IX_TAG.DepositCollateral; new DataView(d.buffer).setBigUint64(17, amount, true);
      return rawIx([...d], [owner, SLAB]);
    };
    const creation = { sig: "c", tx: fakeTx(CREATOR, [init(), memo()]) };
    const withJt = await read(conn([creation, { sig: "j", tx: fakeTx(CREATOR, [rawIx([...jt], [CREATOR, SLAB])]) }]));
    expect(withJt.ok && withJt.facts.seedKind).toBe("junior-tranche");
    expect(withJt.ok && withJt.facts.depositAmounts).toEqual([7n]);

    const foreign = await read(conn([creation, { sig: "d", tx: fakeTx(STRANGER, [dep(STRANGER, 5n)]) }]));
    expect(foreign.ok && foreign.facts.seedKind).toBe("none");
    expect(foreign.ok && foreign.facts.depositAmounts).toEqual([]);

    const own = await read(conn([creation, { sig: "d", tx: fakeTx(CREATOR, [dep(CREATOR, 5n)]) }]));
    expect(own.ok && own.facts.seedKind).toBe("creator-lp");

    // wrong-length junior / deposit instructions and ones not touching the slab are ignored
    const short = new Uint8Array(10); short[0] = 96;
    const noise = await read(conn([
      creation,
      { sig: "n", tx: fakeTx(CREATOR, [rawIx([...short], [CREATOR, SLAB]), rawIx([...jt], [CREATOR, k()]), rawIx([IX_TAG.DepositCollateral, 1], [CREATOR, SLAB])]) },
    ]));
    expect(noise.ok && noise.facts.seedKind).toBe("none");
  });

  it("creator-m2: all three legacy M2 instructions signed by the creator; two of three is not enough", async () => {
    const creation = { sig: "c", tx: fakeTx(CREATOR, [init(), memo()]) };
    const m2 = (tags: number[], who = CREATOR) => ({ sig: `m${tags.join("-")}`, tx: fakeTx(who, tags.map((t) => rawIx([t], [who, SLAB]))) });
    const all = await read(conn([creation, m2([1, 68, 83])]));
    expect(all.ok && all.facts.seedKind).toBe("creator-m2");
    const two = await read(conn([creation, m2([1, 68])]));
    expect(two.ok && two.facts.seedKind).toBe("none");
    const foreign = await read(conn([creation, m2([1, 68, 83], STRANGER)]));
    expect(foreign.ok && foreign.facts.seedKind).toBe("none");
  });
});

describe("readInitialMarginBps", () => {
  beforeEach(() => __setDevnetV22ForTest(false));
  afterEach(() => __setDevnetV22ForTest(null));
  const rd = (c: unknown) => readInitialMarginBps(c as never, SLAB.toBase58(), WRAPPER.toBase58());
  it("returns the on-chain margin; null when unreadable, zero, or beyond safe-integer range", async () => {
    expect(await rd(conn([{ sig: "a", tx: fakeTx(CREATOR, [init(), memo()]) }]))).toBe(1000);
    expect(await rd(conn([]))).toBeNull();
    expect(await rd(conn([{ sig: "a", tx: fakeTx(CREATOR, [init(initData(219, 0n)), memo()]) }]))).toBeNull();
    expect(await rd(conn([{ sig: "a", tx: fakeTx(CREATOR, [init(initData(219, 2n ** 60n)), memo()]) }]))).toBeNull();
  });
});

describe("recoverLaunchFromChain: refusals before any proof is attempted", () => {
  beforeEach(() => __setDevnetV22ForTest(false));
  afterEach(() => __setDevnetV22ForTest(null));
  const base = (txs: { sig: string; tx: unknown }[], over: Record<string, unknown> = {}) => ({
    connection: conn(txs), wrapperProgramId: WRAPPER.toBase58(), isDevnetEnv: true,
    searchPools: vi.fn(async () => ({ pools: [] })), fetchMeta: vi.fn(async () => ({ symbol: "A", name: "a" })), ...over,
  }) as never;
  const creation = [{ sig: "c", tx: fakeTx(CREATOR, [init(), memo()]) }];
  const inp = (o: Record<string, unknown> = {}) => ({ slab: SLAB.toBase58(), wallet: CREATOR.toBase58(), mainnetCA: MINT.toBase58(), ...o });

  it("bad token address", async () => {
    expect(await recoverLaunchFromChain(base(creation), inp({ mainnetCA: "nope" }))).toEqual({ ok: false, reason: "bad-address" });
  });
  it("chain read failure is passed through", async () => {
    expect(await recoverLaunchFromChain(base([]), inp())).toEqual({ ok: false, reason: "no-creation-tx" });
  });
  it("someone else's market is refused before any pool lookup", async () => {
    const d = base(creation);
    expect(await recoverLaunchFromChain(d, inp({ wallet: STRANGER.toBase58() }))).toEqual({ ok: false, reason: "not-your-market" });
    expect((d as { searchPools: ReturnType<typeof vi.fn> }).searchPools).not.toHaveBeenCalled();
  });
  it("no deposit and no creator-supplied LP candidates -> no-deposit; empty candidates list too", async () => {
    expect(await recoverLaunchFromChain(base(creation), inp())).toEqual({ ok: false, reason: "no-deposit" });
    expect(await recoverLaunchFromChain(base(creation), inp({ lpCandidates: [] }))).toEqual({ ok: false, reason: "no-deposit" });
  });
  it("pool lookup throwing -> pools-unavailable; no pools -> no-pools", async () => {
    const throwing = base(creation, { searchPools: vi.fn(async () => { throw new Error("x"); }) });
    expect(await recoverLaunchFromChain(throwing, inp({ lpCandidates: [1n] }))).toEqual({ ok: false, reason: "pools-unavailable" });
    expect(await recoverLaunchFromChain(base(creation), inp({ lpCandidates: [1n] }))).toEqual({ ok: false, reason: "no-pools" });
  });
  it("token metadata failing does not stop the attempt; a pool with no dex type or a wrong memo ends in no-match", async () => {
    const pool = (dexType: string | null) => ({ poolAddress: k().toBase58(), dexType, baseSymbol: "A", quoteSymbol: "SOL" });
    const failingMeta = base(creation, {
      searchPools: vi.fn(async () => ({ pools: [pool(null), pool("meteora-dlmm")] })),
      fetchMeta: vi.fn(async () => { throw new Error("no meta"); }),
    });
    expect(await recoverLaunchFromChain(failingMeta, inp({ lpCandidates: [1n] }))).toEqual({ ok: false, reason: "no-match" });
    expect((failingMeta as { fetchMeta: ReturnType<typeof vi.fn> }).fetchMeta).toHaveBeenCalled();
  });
  it("same symbol/name derivations are tried once (token meta equals the pool's pair)", async () => {
    const pool = { poolAddress: k().toBase58(), dexType: "meteora-dlmm", baseSymbol: "A", quoteSymbol: "SOL" };
    const d = base(creation, {
      searchPools: vi.fn(async () => ({ pools: [pool] })),
      fetchMeta: vi.fn(async () => ({ symbol: "A", name: "A/SOL Perpetual" })),
    });
    expect(await recoverLaunchFromChain(d, inp({ lpCandidates: [1n] }))).toEqual({ ok: false, reason: "no-match" });
  });
});

describe("applying a recovered launch", () => {
  const launch = (o: Partial<RecoveredLaunch> = {}, req: Record<string, unknown> = {}): RecoveredLaunch => ({
    request: { slabAddress: "S", mainnetCA: "CA", dexPoolAddress: "P", dexType: "meteora-dlmm", symbol: "X", proofTx: "sig", payload: { a: 1 }, ...req } as never,
    creator: "C", symbol: "X", name: "x", poolAddress: "P", dexType: "meteora-dlmm", lpCollateralAtoms: 5n,
    initialMarginBps: 1000, tradingFeeBps: 5, initialPriceE6: 9n, maxPortfolioAssets: 4, ...o,
  });
  const live: ResumableParams = { initialPriceE6: 1n, tradingFeeBps: 1, initialMarginBps: 1, lpCollateral: 1n, mainnetCA: "LIVE", insuranceAmount: 3n, lpExposureBps: 11 };

  it("null launch leaves params alone", () => {
    expect(applyRecoveredLaunch(live, null)).toBe(live);
  });
  it("keeps the live insurance / exposure when the chain shows none, and the live CA when the request has none", () => {
    const out = applyRecoveredLaunch(live, launch({ onChainInsuranceAtoms: 0n }, { mainnetCA: undefined }));
    expect(out.mainnetCA).toBe("LIVE");
    expect(out.insuranceAmount).toBe(3n);
    expect(out.lpExposureBps).toBe(11);
    expect(out.p3).toBeUndefined();
    expect(out.oracleMode).toBe("keeper");
  });
  it("pins insurance (only when above zero) and exposure when known", () => {
    expect(applyRecoveredLaunch(live, launch({ onChainInsuranceAtoms: 8n, lpExposureBps: 22 }))).toMatchObject({ insuranceAmount: 8n, lpExposureBps: 22, mainnetCA: "CA" });
    expect(applyRecoveredLaunch(live, launch({ onChainInsuranceAtoms: null })).insuranceAmount).toBe(3n);
  });

  it("adoptRecoveredLaunch saves a request without payloadRequired when no payload was recovered", () => {
    const mem = new Map<string, string>();
    const store: KeyStore = { getItem: (key) => mem.get(key) ?? null, setItem: (key, v) => void mem.set(key, v), removeItem: (key) => void mem.delete(key) } as KeyStore;
    adoptRecoveredLaunch(launch({}, { payload: undefined }), store);
    const saved = [...mem.entries()].map(([key, v]) => [key, v] as const);
    expect(saved.some(([, v]) => v.includes("payloadRequired"))).toBe(false);
    expect(saved.some(([, v]) => v.includes("\"dexType\":\"meteora-dlmm\""))).toBe(true);
  });

  it("unboundResumeValues words the exposure line when it is known and the insurance line by funding", () => {
    const withExp = unboundResumeValues(launch({ lpExposureBps: 500, onChainInsuranceAtoms: 2_000_000n }));
    expect(withExp[0]).toContain("Insurance: 2");
    expect(withExp[2]).toContain("Trade limits (per-trade and position caps)");
    const without = unboundResumeValues(launch());
    expect(without[0]).toContain("nothing is funded yet");
    expect(without[2]).toContain("already written at the liquidity step");
  });
});

describe("pinSameBrowserResume: every malformed saved field refuses instead of resuming", () => {
  const SLABB = k().toBase58(); const POOLB = k().toBase58(); const WALLETB = k().toBase58();
  const good = (o: Record<string, unknown> = {}) => ({
    slab_address: SLABB, deployer: WALLETB, symbol: "A", name: "a", dex_pool_address: POOLB, mainnet_ca: "CA",
    initial_price_e6: "3695", trading_fee_bps: 7, lp_collateral: "42", ...o,
  });
  const pin = (payload: Record<string, unknown> | null, o: Record<string, unknown> = {}) =>
    pinSameBrowserResume({ slab: SLABB, fromStep: 1, payload, chainMarginBps: 1000, savedRequest: { dexType: "meteora-dlmm" }, ...o });

  it("baseline resumes", () => {
    expect(pin(good()).ok).toBe(true);
  });
  it.each([
    ["price not a number-like", { initial_price_e6: {} }],
    ["price unparsable string", { initial_price_e6: "abc" }],
    ["price zero", { initial_price_e6: "0" }],
    ["lp missing", { lp_collateral: undefined }],
    ["lp negative", { lp_collateral: "-1" }],
    ["fee a string", { trading_fee_bps: "7" }],
    ["fee negative", { trading_fee_bps: -1 }],
    ["fee NaN", { trading_fee_bps: Number.NaN }],
    ["pool not a string", { dex_pool_address: 5 }],
    ["symbol not a string", { symbol: 5 }],
    ["name not a string", { name: null }],
    ["ca not a string", { mainnet_ca: 5 }],
    ["wrong slab", { slab_address: "other" }],
    ["foreign deployer", { deployer: "someone-else" }],
  ])("%s", (_n, over) => {
    expect(pin(good(over), { wallet: WALLETB }).ok).toBe(false);
  });
  it("accepts numeric and bigint price/lp encodings", () => {
    const r = pin(good({ initial_price_e6: 3695, lp_collateral: 42n }));
    expect(r.ok && r.pin?.initialPriceE6).toBe(3695n);
    expect(r.ok && r.pin?.lpCollateralAtoms).toBe(42n);
  });
  it("margin must be a positive integer from chain", () => {
    for (const m of [null, undefined, 0, -5, 12.5]) expect(pin(good(), { chainMarginBps: m }).ok).toBe(false);
  });
  it("dex type: a saved request for a different pool does not lend its type; live detection of the same pool does, but only if it has a type", () => {
    const savedOther = { dexType: "pumpswap", dexPoolAddress: "other" };
    expect(pin(good(), { savedRequest: savedOther }).ok).toBe(false);
    expect(pin(good(), { savedRequest: savedOther, live: { poolAddress: POOLB, dexType: null } }).ok).toBe(false);
    expect(pin(good(), { savedRequest: savedOther, live: { poolAddress: POOLB } }).ok).toBe(false);
    const r = pin(good(), { savedRequest: savedOther, live: { poolAddress: POOLB, dexType: "raydium-clmm" } });
    expect(r.ok && r.pin?.dexType).toBe("raydium-clmm");
    expect(pin(good(), { savedRequest: { dexType: "x", dexPoolAddress: POOLB } }).ok).toBe(true);
  });
  it("a keeper-priced form with nothing saved refuses (no payload) rather than resuming unpinned", () => {
    expect(pinSameBrowserResume({ slab: SLABB, fromStep: 2, payload: null, liveIsKeeper: true }).ok).toBe(false);
    expect(pinSameBrowserResume({ slab: SLABB, fromStep: 2, payload: null, proofTx: "sig" }).ok).toBe(false);
  });
});
