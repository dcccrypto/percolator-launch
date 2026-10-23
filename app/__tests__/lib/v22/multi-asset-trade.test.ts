/**
 * Q-7 (2026-10-12): buildMultiAssetTradeIxsV22 / refineMultiAssetTradePlanV22 on real devnet state. Fixture
 * test/fixtures/v22-q7-devnet-2026-10-12.json: market 2xhsLP9N (5 assets), QA portfolio B1xCpgJ3 (3 legs), LP (3 legs),
 * the reference script's instructions for the same state, and the read-only simulation results (nothing sent).
 */
// App port of percolator-sdk 418f0cd test/v22-multi-asset-trade.test.ts (the SDK error-hint cases stay in the SDK).
// @vitest-environment node
import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  buildMultiAssetTradeIxsV22, refineMultiAssetTradePlanV22, buildRefreshCrankIxV22,
  WRAPPER_PRE_CRANK_MIN_LEGS_V22, MULTI_ASSET_TRADE_COMPUTE_UNITS_V22, MULTI_ASSET_TRADE_MAX_EXTRA_CRANKS_V22,
} from "@/lib/v22/sdk";
const PROGRAM_IDS_DEVNET_V22 = { percolator: "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM", nft: "27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1" };

interface Ser { programId: string; keys: string[]; data: string }
const FX = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-q7-devnet-2026-10-12.json"), "utf8")) as {
  market: string; portfolio: string; lp: string; owner: string;
  accounts: { market: string; taker: string; lp: string; flatPortfolio: string };
  cases: { label: string; scriptIxs: Ser[]; plain: { err: unknown; logs: string[] }; result: { ok: boolean; cranks: string[]; cu: number } }[];
};
const FEE = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: Record<string, Record<string, string>> };
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const W = new PublicKey(PROGRAM_IDS_DEVNET_V22.percolator), MKT = new PublicKey(FX.market), P = new PublicKey(FX.portfolio), LP = new PublicKey(FX.lp), OWNER = new PublicKey(FX.owner);
const ser = (ix: TransactionInstruction): Ser => ({ programId: ix.programId.toBase58(), keys: ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`), data: Buffer.from(ix.data).toString("hex") });
const unser = (s: Ser): TransactionInstruction => new TransactionInstruction({ programId: new PublicKey(s.programId), keys: s.keys.map((k) => { const [pk, f] = k.split(":"); return { pubkey: new PublicKey(pk!), isSigner: f![0] === "s", isWritable: f![1] === "w" }; }), data: Buffer.from(s.data, "hex") });
const input = (tradeIx: TransactionInstruction) => ({ programId: W, market: MKT, marketData: b64(FX.accounts.market), cranker: OWNER, takerPortfolio: P, takerData: b64(FX.accounts.taker), lpPortfolio: LP, lpData: b64(FX.accounts.lp), tradeIx });
const tradeOf = (c: (typeof FX.cases)[number]): TransactionInstruction => unser(c.scriptIxs[c.scriptIxs.length - 1]!);

describe("Q-7 buildMultiAssetTradeIxsV22 (real devnet state)", () => {
  it("constants: pre-crank threshold 3 legs, 1.4M CU", () => {
    expect(WRAPPER_PRE_CRANK_MIN_LEGS_V22).toBe(3);
    expect(MULTI_ASSET_TRADE_COMPUTE_UNITS_V22).toBe(1_400_000);
  });
  it("covers 3 closes and a 4th-leg open, every one simulated clean on devnet with the builder's shape", () => {
    expect(FX.cases.map((c) => c.label.split(" asset")[0])).toEqual(["close", "close", "close", "open 4th leg"]);
    for (const c of FX.cases) {
      expect(c.result.ok).toBe(true);
      expect(c.result.cranks).toEqual(["lpObserve", "taker", "lp"]);
      expect(c.result.cu).toBeLessThan(MULTI_ASSET_TRADE_COMPUTE_UNITS_V22);
    }
  });
  for (const c of FX.cases) {
    it(`${c.label}: byte-for-byte the reference script's instructions`, () => {
      const plan = buildMultiAssetTradeIxsV22(input(tradeOf(c)));
      expect(plan).toMatchObject({ path: "multiAsset", marketSlots: 5, takerActiveLegs: 3, lpActiveLegs: 3, computeUnitLimit: 1_400_000, extraCranks: 0 });
      expect(plan.instructions.map(ser)).toEqual(c.scriptIxs);
      expect(plan.cranks.map((k) => [k.role, k.observations])).toEqual([["lpObserve", [0, 1, 2, 3, 4]], ["taker", []], ["lp", []]]);
    });
    it(`negative control, ${c.label}: the plain trade was refused 19 on devnet`, () => {
      expect(c.plain.err).toEqual({ InstructionError: [2, { Custom: 19 }] });
    });
  }
  it("simple path: a single-asset market returns the trade alone", () => {
    const t = tradeOf(FX.cases[0]!);
    const plan = buildMultiAssetTradeIxsV22({ ...input(t), marketData: b64(FEE.markets["JUP"]!.marketB64!) });
    expect(plan).toMatchObject({ path: "simple", marketSlots: 1, cranks: [], budgetIxs: [] });
    expect(plan.instructions).toEqual([t]);
    expect(plan.computeUnitLimit).toBeUndefined();
  });
  it("simple path: a multi-asset market with both portfolios below 3 legs", () => {
    const flat = b64(FX.accounts.flatPortfolio);
    const plan = buildMultiAssetTradeIxsV22({ ...input(tradeOf(FX.cases[0]!)), takerData: flat, lpData: flat });
    expect(plan).toMatchObject({ path: "simple", marketSlots: 5, takerActiveLegs: 0, lpActiveLegs: 0 });
    expect(plan.instructions).toHaveLength(1);
  });
  it("the LP alone at 3 legs is enough to need the multi-asset shape (the check is on both trade portfolios)", () => {
    const plan = buildMultiAssetTradeIxsV22({ ...input(tradeOf(FX.cases[0]!)), takerData: b64(FX.accounts.flatPortfolio) });
    expect(plan).toMatchObject({ path: "multiAsset", takerActiveLegs: 0, lpActiveLegs: 3 });
  });
  it("an open's stale peers are refreshed between the LP observe crank and the taker; taker/LP are not duplicated", () => {
    const peer = new PublicKey(PROGRAM_IDS_DEVNET_V22.nft);
    const plan = buildMultiAssetTradeIxsV22({ ...input(tradeOf(FX.cases[3]!)), stalePeers: [peer, P, LP] });
    expect(plan.cranks.map((k) => k.role)).toEqual(["lpObserve", "peer", "taker", "lp"]);
    expect(ser(plan.instructions[3]!)).toEqual(ser(buildRefreshCrankIxV22(W, MKT, OWNER, peer, [])));
  });
});

describe("Q-7 refineMultiAssetTradePlanV22 (client rules)", () => {
  const plan = buildMultiAssetTradeIxsV22(input(tradeOf(FX.cases[0]!)));
  const at = (k: number, code: number) => ({ InstructionError: [plan.budgetIxs.length + k, { Custom: code }] });
  it("a refresh refused 22 is dropped", () => {
    const r = refineMultiAssetTradePlanV22(plan, at(1, 22));
    expect(r.action).toBe("retry");
    expect(r.plan.cranks.map((k) => k.role)).toEqual(["lpObserve", "lp"]);
    expect(r.plan.instructions).toHaveLength(plan.instructions.length - 1);
  });
  it("the observing crank refused 22: wait a slot, same plan", () => {
    const r = refineMultiAssetTradePlanV22(plan, at(0, 22));
    expect(r.action).toBe("wait");
    expect(r.plan).toBe(plan);
  });
  it("trade still 19: append taker, then LP, alternating, at most 4, then fail", () => {
    let p = plan; const roles: string[] = [];
    for (let n = 0; n < MULTI_ASSET_TRADE_MAX_EXTRA_CRANKS_V22; n++) {
      const r = refineMultiAssetTradePlanV22(p, { InstructionError: [p.budgetIxs.length + p.cranks.length, { Custom: 19 }] });
      expect(r.action).toBe("retry"); p = r.plan; roles.push(p.cranks[p.cranks.length - 1]!.role);
    }
    expect(roles).toEqual(["taker", "lp", "taker", "lp"]);
    expect(p.instructions[p.instructions.length - 1]).toBe(plan.tradeIx);
    expect(refineMultiAssetTradePlanV22(p, { InstructionError: [p.budgetIxs.length + p.cranks.length, { Custom: 19 }] })).toMatchObject({ action: "fail", code: 19 });
  });
  it("negative controls: any other refusal fails (9 at the trade, 19 at a crank, 22 at the trade, non-instruction error)", () => {
    expect(refineMultiAssetTradePlanV22(plan, at(3, 9))).toMatchObject({ action: "fail", code: 9 });
    expect(refineMultiAssetTradePlanV22(plan, at(1, 19))).toMatchObject({ action: "fail", code: 19 });
    expect(refineMultiAssetTradePlanV22(plan, at(3, 22))).toMatchObject({ action: "fail", code: 22 });
    expect(refineMultiAssetTradePlanV22(plan, "BlockhashNotFound")).toMatchObject({ action: "fail", code: null });
  });
});
