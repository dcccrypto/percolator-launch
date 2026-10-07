/**
 * #3267: a launch's registration can be rebuilt from chain + the token address and proven against the
 * on-chain memo, from any browser. The fixtures are built with the launch's own forward code (the
 * wizard's payload builder, InitMarket encoder and memo), so the recovery has to reproduce what the
 * launch signed, byte for byte.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { IX_TAG, encodeInitMarket, encodeDepositCollateral } from "@percolatorct/sdk";
import { buildV17InitMarketArgs } from "@/lib/create-market-args";
import { deriveLaunchMarketParams } from "@/lib/market-params";
import { buildMarketRegistrationPayload } from "@/lib/market-registration-payload";
import { resolveMarketMetadata } from "@/lib/market-metadata";
import { keeperMemoParams, keeperRegisterMemoText, MEMO_PROGRAM_ID } from "@/lib/keeper-register-memo";
import { registrationCandidates, type KeyStore } from "@/lib/keeper-register-client";
import {
  adoptRecoveredLaunch,
  atomsToHuman,
  decodeInitMarketData,
  inferResumeStep,
  recoverLaunchFromChain,
  RECOVERY_COPY,
  type RecoveryDeps,
} from "@/lib/launch-recovery";
import type { DexPoolResult } from "@/hooks/useDexPoolSearch";

const k = () => Keypair.generate().publicKey;
const WRAPPER = k();
const CREATOR = k();
const OTHER_WALLET = k();
const SLAB = k();
const COLLATERAL = k();
const CRANK = k().toBase58();
const CA = k().toBase58();
const POOL = k().toBase58();
const PROOF_SIG = "5ProofSig11111111111111111111111111111111111111111111111111111111111111111111111111111";
const LP = 1_000_000_000n;
const PRICE = 3695n;

const pool = (address: string, dexType: DexPoolResult["dexType"] = "meteora-dlmm", base = "AUTON"): DexPoolResult => ({
  poolAddress: address, dexId: "meteora", dexType, dexLabel: "Meteora DLMM", pairLabel: `${base} / SOL`,
  baseSymbol: base, quoteSymbol: "SOL", liquidityUsd: 50_000, priceUsd: 0.0037,
});

/** The launch's forward path: what the wizard signs into the creation tx. */
async function forward(o: { meta?: { symbol: string; name: string }; lp?: bigint; poolAddress?: string; dexType?: DexPoolResult["dexType"]; leverageBps?: number } = {}) {
  const meta = o.meta ?? { symbol: "AUTON", name: "auton" };
  const md = resolveMarketMetadata({ symbol: meta.symbol, name: meta.name, mint: CA });
  const lp = o.lp ?? LP;
  const initialMarginBps = o.leverageBps ?? 1000;
  const derived = deriveLaunchMarketParams({ initialMarginBps, lpCollateral: lp, initialPriceE6: PRICE });
  const initData = encodeInitMarket(buildV17InitMarketArgs({ initialPriceE6: PRICE, tradingFeeBps: 5 }, derived));
  const payload = buildMarketRegistrationPayload({
    slabAddress: SLAB.toBase58(),
    params: { mint: COLLATERAL, symbol: md.symbol, name: md.name, decimals: 6, dexPoolAddress: o.poolAddress ?? POOL, initialPriceE6: PRICE, initialMarginBps, tradingFeeBps: 5, lpCollateral: lp, mainnetCA: CA },
    deployer: CREATOR.toBase58(), oracleMode: "keeper", isAdminOracle: false, isDevnetEnv: true, crankWallet: CRANK,
  });
  const memo = await keeperRegisterMemoText(await keeperMemoParams({
    slabAddress: SLAB.toBase58(), mainnetCA: CA, dexPoolAddress: o.poolAddress ?? POOL, dexType: o.dexType ?? "meteora-dlmm", symbol: md.symbol, payload,
  }));
  return { initData, memo, payload, md };
}

type Ix = { programId: PublicKey; keys: PublicKey[]; data: Uint8Array };
function fakeTx(signer: PublicKey, ixs: Ix[], err: unknown = null) {
  const keys: PublicKey[] = [signer];
  const idx = (p: PublicKey) => { let i = keys.findIndex((x) => x.equals(p)); if (i < 0) { keys.push(p); i = keys.length - 1; } return i; };
  const compiledInstructions = ixs.map((ix) => ({ programIdIndex: idx(ix.programId), accountKeyIndexes: ix.keys.map(idx), data: Buffer.from(ix.data) }));
  return { meta: { err }, transaction: { message: { staticAccountKeys: keys, header: { numRequiredSignatures: 1 }, compiledInstructions } } } as never;
}
const initIx = (data: Uint8Array, admin = CREATOR): Ix => ({ programId: WRAPPER, keys: [admin, SLAB, COLLATERAL], data });
const memoIx = (text: string, signer = CREATOR): Ix => ({ programId: MEMO_PROGRAM_ID, keys: [signer], data: Buffer.from(text) });
const depositIx = (amount: bigint): Ix => ({
  programId: WRAPPER, keys: [CREATOR, SLAB],
  data: encodeDepositCollateral({ portfolioId: 1n, expectedSequence: 1n, amount: amount.toString() }),
});

function deps(txs: { sig: string; tx: unknown }[], pools: DexPoolResult[], over: Partial<RecoveryDeps> = {}, meta = { symbol: "AUTON", name: "auton" }): RecoveryDeps & { searchPools: ReturnType<typeof vi.fn> } {
  const searchPools = vi.fn(async () => ({ pools }));
  return {
    connection: {
      // newest first, like the RPC
      getSignaturesForAddress: vi.fn(async () => [...txs].reverse().map((t) => ({ signature: t.sig, err: null }))),
      getTransaction: vi.fn(async (sig: string) => txs.find((t) => t.sig === sig)?.tx ?? null),
    } as never,
    wrapperProgramId: WRAPPER.toBase58(), crankWallet: CRANK, isDevnetEnv: true,
    searchPools, fetchMeta: async () => meta,
    ...over,
  } as never;
}

async function standardChain(o: Parameters<typeof forward>[0] = {}, withDeposit = true) {
  const f = await forward(o);
  const creation = fakeTx(CREATOR, [initIx(f.initData), memoIx(f.memo)]);
  const txs = [{ sig: PROOF_SIG, tx: creation }, { sig: "handoff", tx: fakeTx(CREATOR, []) }];
  if (withDeposit) txs.push({ sig: "deposit", tx: fakeTx(CREATOR, [depositIx(o.lp ?? LP)]) });
  return { f, txs };
}
const input = (o: Partial<{ wallet: string; mainnetCA: string }> = {}) => ({ slab: SLAB.toBase58(), wallet: CREATOR.toBase58(), mainnetCA: CA, ...o });

describe("InitMarket decoding agrees with the SDK encoder", () => {
  it("round-trips price, margin, fee and slot count", () => {
    const derived = deriveLaunchMarketParams({ initialMarginBps: 1000, lpCollateral: LP, initialPriceE6: PRICE });
    const data = encodeInitMarket(buildV17InitMarketArgs({ initialPriceE6: PRICE, tradingFeeBps: 5 }, derived));
    expect(decodeInitMarketData(data)).toEqual({ maxPortfolioAssets: 14, initialPriceE6: PRICE, initialMarginBps: 1000n, maxTradingFeeBps: 5n, tradeFeeBaseBps: 5n });
  });
  it("refuses anything that is not a 219-byte InitMarket", () => {
    expect(decodeInitMarketData(new Uint8Array(10))).toBeNull();
    const d = new Uint8Array(219); d[0] = 3;
    expect(decodeInitMarketData(d)).toBeNull();
  });
});

describe("recovering a launch's registration from chain + the token address", () => {
  it("rebuilds the exact request the launch signed, and it matches the on-chain memo", async () => {
    const { f, txs } = await standardChain();
    const r = await recoverLaunchFromChain(deps(txs, [pool("Decoy1111111111111111111111111111111111111", "pumpswap"), pool(POOL)]), input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.launch.request).toMatchObject({ slabAddress: SLAB.toBase58(), mainnetCA: CA, dexPoolAddress: POOL, dexType: "meteora-dlmm", symbol: "AUTON", proofTx: PROOF_SIG });
    expect(r.launch.request.payload).toEqual(f.payload);
    expect(r.launch.lpCollateralAtoms).toBe(LP);
    expect(r.launch.creator).toBe(CREATOR.toBase58());
    // the memo of the rebuilt request is the on-chain one
    const again = await keeperRegisterMemoText(await keeperMemoParams({ ...r.launch.request, payload: r.launch.request.payload }));
    expect(again).toBe(f.memo);
  });

  it("works for a 6.5x market whose margin bps are not a whole leverage", async () => {
    const { txs } = await standardChain({ leverageBps: 1538 });
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input());
    expect(r.ok).toBe(true);
  });

  it("derives symbol and name from the token metadata (a name with no Latin letters falls back as the wizard does)", async () => {
    const meta = { symbol: "ちいかわ", name: "ちいかわ" };
    const { txs } = await standardChain({ meta });
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL)], {}, meta), input());
    expect(r.ok).toBe(true);
  });

  // ── negative controls: each of these must NOT verify ──
  it("a different token address does not verify", async () => {
    const { txs } = await standardChain();
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input({ mainnetCA: k().toBase58() }));
    expect(r).toEqual({ ok: false, reason: "no-match" });
  });
  it("a token whose pools do not include the launch's pool does not verify", async () => {
    const { txs } = await standardChain();
    const r = await recoverLaunchFromChain(deps(txs, [pool("Other11111111111111111111111111111111111111")]), input());
    expect(r).toEqual({ ok: false, reason: "no-match" });
  });
  it("a different token name (same pool) does not verify", async () => {
    const { txs } = await standardChain();
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL, "meteora-dlmm", "OTHER")], {}, { symbol: "OTHER", name: "other" }), input());
    expect(r).toEqual({ ok: false, reason: "no-match" });
  });
  it("a wrong dex type for the pool does not verify", async () => {
    const { txs } = await standardChain();
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL, "pumpswap")]), input());
    expect(r).toEqual({ ok: false, reason: "no-match" });
  });
  it("an LP seed that differs from the memo-bound one does not verify (nothing is guessed)", async () => {
    const f = await forward({ lp: 7_000_000_000n });
    const txs = [{ sig: PROOF_SIG, tx: fakeTx(CREATOR, [initIx(f.initData), memoIx(f.memo)]) }, { sig: "deposit", tx: fakeTx(CREATOR, [depositIx(LP)]) }];
    expect(await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input())).toEqual({ ok: false, reason: "no-match" });
  });
  it("another wallet cannot recover this market: refused before any token lookup", async () => {
    const { txs } = await standardChain();
    const d = deps(txs, [pool(POOL)]);
    expect(await recoverLaunchFromChain(d, input({ wallet: OTHER_WALLET.toBase58() }))).toEqual({ ok: false, reason: "not-your-market" });
    expect(d.searchPools).not.toHaveBeenCalled();
  });
  it("a memo signed by someone other than the InitMarket admin does not verify", async () => {
    const f = await forward();
    const txs = [{ sig: PROOF_SIG, tx: fakeTx(CREATOR, [initIx(f.initData), memoIx(f.memo, OTHER_WALLET)]) }, { sig: "deposit", tx: fakeTx(CREATOR, [depositIx(LP)]) }];
    // OTHER_WALLET is not a signer of this tx (header says 1 signer), so the memo has no signer at all
    expect(await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input())).toEqual({ ok: false, reason: "no-match" });
  });
  it("a creation tx with no registration memo, or two, is refused", async () => {
    const f = await forward();
    const none = [{ sig: PROOF_SIG, tx: fakeTx(CREATOR, [initIx(f.initData)]) }, { sig: "deposit", tx: fakeTx(CREATOR, [depositIx(LP)]) }];
    expect(await recoverLaunchFromChain(deps(none, [pool(POOL)]), input())).toEqual({ ok: false, reason: "no-memo" });
    const two = [{ sig: PROOF_SIG, tx: fakeTx(CREATOR, [initIx(f.initData), memoIx(f.memo), memoIx(f.memo)]) }, { sig: "deposit", tx: fakeTx(CREATOR, [depositIx(LP)]) }];
    expect(await recoverLaunchFromChain(deps(two, [pool(POOL)]), input())).toEqual({ ok: false, reason: "several-memos" });
  });
  it("no deposit in the launch history: says so rather than guessing a seed", async () => {
    const { txs } = await standardChain({}, false);
    expect(await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input())).toEqual({ ok: false, reason: "no-deposit" });
  });
  it("bad address, no pools, failed pool lookup, failed chain read", async () => {
    const { txs } = await standardChain();
    expect(await recoverLaunchFromChain(deps(txs, []), input({ mainnetCA: "not-a-key" }))).toEqual({ ok: false, reason: "bad-address" });
    expect(await recoverLaunchFromChain(deps(txs, []), input())).toEqual({ ok: false, reason: "no-pools" });
    expect(await recoverLaunchFromChain(deps(txs, [], { searchPools: async () => { throw new Error("429"); } }), input())).toEqual({ ok: false, reason: "pools-unavailable" });
    const broken = deps(txs, [pool(POOL)]);
    (broken.connection as unknown as { getSignaturesForAddress: unknown }).getSignaturesForAddress = async () => { throw new Error("rpc"); };
    expect(await recoverLaunchFromChain(broken, input())).toEqual({ ok: false, reason: "rpc" });
  });
  it("every refusal has creator copy", () => {
    for (const reason of Object.keys(RECOVERY_COPY) as (keyof typeof RECOVERY_COPY)[]) expect(RECOVERY_COPY[reason].length).toBeGreaterThan(10);
  });
});

describe("adopting a verified launch on this device", () => {
  const store = (): KeyStore & { m: Map<string, string> } => {
    const m = new Map<string, string>();
    return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (x) => m.get(x) ?? null, setItem: (x, v) => void m.set(x, v) };
  };
  beforeEach(() => window.localStorage.clear());
  it("leaves exactly what the launching browser would have saved, so the saved-retry path finds it", async () => {
    const { txs } = await standardChain();
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input());
    if (!r.ok) throw new Error("expected a verified launch");
    adoptRecoveredLaunch(r.launch);
    const found = registrationCandidates(SLAB.toBase58(), window.localStorage);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dexPoolAddress: POOL, dexType: "meteora-dlmm", symbol: "AUTON", mainnetCA: CA, proofTx: PROOF_SIG });
    expect(found[0].payload).toEqual(r.launch.request.payload);
    void store;
  });
});

describe("resume helpers", () => {
  it("start step from the chain: no portfolio -> 1, portfolio no capital -> 2, capital -> 3 (never 0)", () => {
    expect(inferResumeStep({ portfolios: 0n, cTot: 0n })).toBe(1);
    expect(inferResumeStep({ portfolios: 1n, cTot: 0n })).toBe(2);
    expect(inferResumeStep({ portfolios: 2n, cTot: 5n })).toBe(3);
  });
  it("atoms to the wizard's human amount", () => {
    expect(atomsToHuman(1_000_000_000n, 6)).toBe("1000");
    expect(atomsToHuman(1_500_000n, 6)).toBe("1.5");
    expect(atomsToHuman(1n, 6)).toBe("0.000001");
  });
});
void IX_TAG;

import fs from "fs";
import path from "path";
import { applyRecoveredLaunch, canResumeLaunch, chainResumeRefusal, CHAIN_RESUME_MISMATCH_COPY, unboundResumeValues, type RecoveredLaunch } from "@/lib/launch-recovery";

describe("a chain-recovered resume pins the launch's parameters", () => {
  const launch = { initialPriceE6: PRICE, tradingFeeBps: 5, initialMarginBps: 1000, lpCollateralAtoms: LP, symbol: "AUTON", name: "auton", poolAddress: POOL, dexType: "meteora-dlmm", maxPortfolioAssets: 14, request: { mainnetCA: CA } } as unknown as RecoveredLaunch;
  const live = { initialPriceE6: 999n, tradingFeeBps: 30, initialMarginBps: 2000, lpCollateral: 1n, symbol: "OTHER", name: "other", mainnetCA: "x", dexPoolAddress: "otherPool", dexType: "pumpswap", oracleMode: "admin" as const, p3: { juniorAtoms: 1n } };
  it("overrides whatever the live wizard re-detected", () => {
    expect(applyRecoveredLaunch(live, launch)).toMatchObject({ initialPriceE6: PRICE, tradingFeeBps: 5, initialMarginBps: 1000, lpCollateral: LP, symbol: "AUTON", name: "auton", mainnetCA: CA, dexPoolAddress: POOL, dexType: "meteora-dlmm", oracleMode: "keeper" });
  });
  it("never carries the P3 flag over from today's form: a resume's p3 does not depend on the flag", () => {
    expect(applyRecoveredLaunch(live, launch).p3).toBeUndefined();
    expect(applyRecoveredLaunch(live, { ...launch, maxPortfolioAssets: 1 } as RecoveredLaunch).p3).toBeUndefined();
  });
  it("a one-slot (vault-owned-LP) market is refused for resume; a 14-slot one is allowed", () => {
    const refused = canResumeLaunch({ maxPortfolioAssets: 1 });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/can't be resumed from here yet/);
    expect(canResumeLaunch({ maxPortfolioAssets: 14 })).toEqual({ ok: true });
  });
  it("pins the insurance to the slab's funded balance when above zero, else leaves the form's", () => {
    expect(applyRecoveredLaunch({ ...live, insuranceAmount: 5n }, { ...launch, onChainInsuranceAtoms: 250n } as RecoveredLaunch).insuranceAmount).toBe(250n);
    expect(applyRecoveredLaunch({ ...live, insuranceAmount: 5n }, { ...launch, onChainInsuranceAtoms: 0n } as RecoveredLaunch).insuranceAmount).toBe(5n);
    expect(applyRecoveredLaunch({ ...live, insuranceAmount: 5n }, { ...launch, onChainInsuranceAtoms: null } as RecoveredLaunch).insuranceAmount).toBe(5n);
  });
  it("pins the LP exposure the creator confirmed; leaves the form's alone once the matcher exists", () => {
    expect(applyRecoveredLaunch({ ...live, lpExposureBps: 10_000 }, { ...launch, lpExposureBps: 12_500 } as RecoveredLaunch).lpExposureBps).toBe(12_500);
    expect(applyRecoveredLaunch({ ...live, lpExposureBps: 10_000 }, launch).lpExposureBps).toBe(10_000);
  });
  it("lists every value the wallet signs that the memo does not bind", () => {
    const lines = unboundResumeValues({ ...launch, onChainInsuranceAtoms: 0n } as RecoveredLaunch);
    expect(lines.join("\n")).toMatch(/Insurance top-up: the amount in this form/);
    expect(lines.join("\n")).toMatch(/backing seed/);
    expect(lines.join("\n")).toMatch(/Trade limits/);
    expect(unboundResumeValues({ ...launch, onChainInsuranceAtoms: 3_000_000n } as RecoveredLaunch)[0]).toBe("Insurance: 3, as already funded on chain.");
  });
  it("a refused Retry/launch: wrong slab, wrong wallet, or a one-slot market; null only when all agree", () => {
    const r = { creator: "A", maxPortfolioAssets: 14, request: { slabAddress: "Y" } };
    expect(chainResumeRefusal(r, "Y", "A")).toBeNull();
    expect(chainResumeRefusal(r, "X", "A")).toBe(CHAIN_RESUME_MISMATCH_COPY);
    expect(chainResumeRefusal(r, "Y", "B")).toBe(CHAIN_RESUME_MISMATCH_COPY);
    expect(chainResumeRefusal(r, "Y", null)).toBe(CHAIN_RESUME_MISMATCH_COPY);
    expect(chainResumeRefusal({ ...r, maxPortfolioAssets: 1 }, "Y", "A")).toMatch(/can't be resumed from here yet/);
  });
  it("with no recovery it changes nothing (the normal launch and the local resume are untouched)", () => {
    expect(applyRecoveredLaunch(live, null)).toBe(live);
  });
  it("the wizard routes every create() call through it", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"), "utf8");
    expect(src).toContain("create(applyRecoveredLaunch(params, gate.resume), resumeFromStep ?? undefined);");
    expect(src).toContain("create(applyRecoveredLaunch(params, gate.resume), createState.step);");
    expect(src).toContain("restoreSlabAddress(resumeSlabParam);");
    // security review C: the resume belongs to one slab and one wallet, and is gated before every launch/retry
    expect(src).toContain("chainResumeRefusal(r, resumeSlab, walletB58)");
    expect(src).toContain("useChainResumeWalletGuard(walletB58, !!chainResume");
    expect(src.match(/const gate = gateChainResume\(\);\n\s+if \(!gate\.ok\) return;/g)?.length).toBe(2);
    // a local resume replaces any chain resume
    expect(src).toMatch(/setChainResume\(null\);\n\s+setChainResumeError\(null\);\n\s+\/\/ Set resumeFromStep so handleLaunch/);
  });
});


describe("registration-only recovery of a FINISHED vault-owned-LP (one-slot) market", () => {
  it("is proven from the junior-tranche deposit, while a resume of the same market is refused", async () => {
    const lp = 5_000_000_000n;
    const md = resolveMarketMetadata({ symbol: "AUTON", name: "auton", mint: CA });
    const derived = deriveLaunchMarketParams({ initialMarginBps: 1000, lpCollateral: lp, initialPriceE6: PRICE });
    const initData = encodeInitMarket(buildV17InitMarketArgs({ initialPriceE6: PRICE, tradingFeeBps: 5, p3: { juniorFloorBps: 1 } }, derived));
    expect(decodeInitMarketData(initData)?.maxPortfolioAssets).toBe(1);
    const payload = buildMarketRegistrationPayload({
      slabAddress: SLAB.toBase58(),
      params: { mint: COLLATERAL, symbol: md.symbol, name: md.name, decimals: 6, dexPoolAddress: POOL, initialPriceE6: PRICE, initialMarginBps: 1000, tradingFeeBps: 5, lpCollateral: lp, mainnetCA: CA },
      deployer: CREATOR.toBase58(), oracleMode: "keeper", isAdminOracle: false, isDevnetEnv: true, crankWallet: CRANK,
    });
    const memo = await keeperRegisterMemoText(await keeperMemoParams({ slabAddress: SLAB.toBase58(), mainnetCA: CA, dexPoolAddress: POOL, dexType: "meteora-dlmm", symbol: md.symbol, payload }));
    const junior = Buffer.alloc(17);
    junior[0] = 96;
    junior.writeBigUInt64LE(lp & 0xffffffffffffffffn, 1);
    const txs = [
      { sig: PROOF_SIG, tx: fakeTx(CREATOR, [initIx(initData), memoIx(memo)]) },
      { sig: "junior", tx: fakeTx(CREATOR, [{ programId: WRAPPER, keys: [CREATOR, SLAB], data: junior }]) },
    ];
    const r = await recoverLaunchFromChain(deps(txs, [pool(POOL)]), input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.launch.maxPortfolioAssets).toBe(1);
    expect(r.launch.lpCollateralAtoms).toBe(lp);
    expect(r.launch.request.payload).toEqual(payload);
    expect(canResumeLaunch(r.launch).ok).toBe(false); // registration yes, resume no
    // CONTROL: without the junior deposit there is nothing to prove the seed from
    expect(await recoverLaunchFromChain(deps([txs[0]], [pool(POOL)]), input())).toEqual({ ok: false, reason: "no-deposit" });
  });
});
