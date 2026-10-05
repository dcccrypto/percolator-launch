// @vitest-environment node
/**
 * MEASUREMENT (not behaviour): the real instructions the app builds for (c) the Earn exit bundle
 * (R3-M1 refresh cranks + tag 77) and (d) the Move-to-v2.1 steps, packed in legacy / v0 (no ALTs) /
 * v1 with the app's budget (128 KiB heap + CU limit + CU price). Bytes and accounts are exact (the
 * real compile); CU per instruction are ESTIMATES (sources inline) and only decide CU-binding.
 *
 * The assertions pin the conclusions the PR relies on:
 *  - (c) is CU-bound: the app's 4 cranks + 77 fit one legacy tx; the CU ceiling caps a tx at 8
 *    cranks in EVERY format, and legacy bytes still fit at 8, so v1 never cuts the tx count.
 *  - (d) every Move action is one transaction per step per market by design (#3148 plan.ts
 *    nextActions); each fits legacy, so v1 cannot remove a prompt there. v1 only matters for a
 *    cross-market batch the flow does not do (reported, not wired).
 * Run with TX_V1_MEASURE_PRINT=1 to print the table.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNTS_WITHDRAW_COLLATERAL, buildAccountMetas, buildIx, encodeWithdrawCollateral, WELL_KNOWN } from "@percolatorct/sdk";
import { buildEarnExecuteIxs, buildRequestRedeemIx } from "@/lib/limits/earn-ixs";
import { buildExitCrankIxs, MAX_EXIT_CRANKS } from "@/lib/v21/exit-cranks";
import { buildRebalanceBackingIx } from "@/lib/limits/earn-split-pot";
import { buildTradeIxs } from "@/lib/trade-ix";
import { measureBundleFormats, planUserBundle, type PackGroup } from "@/lib/tx-v1/user-bundle";
import { TX_LEGACY_MAX_BYTES, TX_V1_MAX_BYTES } from "@/lib/v21/sdk";

// CU estimates (inferred, not measured here):
const CU_CRANK = 145_000; // refresh crank (SDK tx-v1 measurement / exit-cranks.ts "~100-150k")
const CU_EXECUTE_77 = 150_000; // exit-cranks.ts budgets 1M for 4 cranks + 77
const CU_REBALANCE_91 = 40_000;
const CU_REQUEST_76 = 40_000;
const CU_WITHDRAW = 49_000; // hooks/useWithdraw.ts comment (devnet-measured ~49k)
const CU_CLOSE_LEG = 400_000; // lib/compute-budget.ts CU_PER_LEG_CAP (trade CU cap per leg)

const PRINT = process.env.TX_V1_MEASURE_PRINT === "1";
let seed = 1;
const k = (): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(seed++ % 250)).publicKey;
const wallet = k();
const programId = k();

interface Market {
  market: PublicKey; registry: PublicKey; redemption: PublicKey; lpMint: PublicKey; escrow: PublicKey; vaultToken: PublicKey;
  vaultAuthority: PublicKey; ledger: PublicKey; siblingLedger: PublicKey; redeemerDest: PublicKey; redeemerLpAta: PublicKey;
  portfolio: PublicKey; lp: PublicKey; matcherProg: PublicKey; matcherCtx: PublicKey; matcherDelegate: PublicKey;
}
const newMarket = (): Market => ({
  market: k(), registry: k(), redemption: k(), lpMint: k(), escrow: k(), vaultToken: k(), vaultAuthority: k(), ledger: k(),
  siblingLedger: k(), redeemerDest: k(), redeemerLpAta: k(), portfolio: k(), lp: k(), matcherProg: k(), matcherCtx: k(), matcherDelegate: k(),
});

const execute77 = (m: Market) =>
  buildEarnExecuteIxs({
    programId, redeemer: wallet, market: m.market, registry: m.registry, redemption: m.redemption, lpMint: m.lpMint,
    escrow: m.escrow, vaultToken: m.vaultToken, vaultAuthority: m.vaultAuthority, ledger: m.ledger, redeemerDest: m.redeemerDest,
    siblingLedger: m.siblingLedger, domain: 0, plan: { ok: true, tail: null, prependHarvest: false },
  });
const request76 = (m: Market) =>
  buildRequestRedeemIx({ programId, redeemer: wallet, registry: m.registry, lpMint: m.lpMint, redeemerLpAta: m.redeemerLpAta, escrow: m.escrow, redemption: m.redemption, shares: 123_456_789n });
const rebalance91 = (m: Market) =>
  buildRebalanceBackingIx({ programId, cranker: wallet, market: m.market, registry: m.registry, fromLedger: m.siblingLedger, toLedger: m.ledger, fromDomain: 1, toDomain: 0, amount: 1_000_000n });
const withdraw = (m: Market) =>
  buildIx({
    programId,
    keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [wallet, m.market, m.portfolio, m.redeemerDest, m.vaultToken, m.vaultAuthority, WELL_KNOWN.tokenProgram]),
    data: encodeWithdrawCollateral({ portfolioId: 7n, expectedSequence: 9n, amount: "1000000" }),
  });
const closeLeg = (m: Market) =>
  buildTradeIxs({
    programId, signer: wallet, market: m.market, accountA: m.portfolio, accountB: m.lp, matcherProg: m.matcherProg, matcherCtx: m.matcherCtx,
    matcherDelegate: m.matcherDelegate, takerId: { portfolioId: 1n, positionEpoch: 2n }, lpId: { portfolioId: 3n, positionEpoch: 4n, matcherSequence: 5n },
    marketId: 1n, legs: [], size: -1_000_000n, limitPriceE6: 1n, feeBps: 10n, marketTradeFeeBps: 10n,
  });

/** Earn exit as useInsuranceLP builds it: [cranks..., (91), 77]. Cranks are separate groups only for the max-cranks probe. */
function earnExit(m: Market, cranks: number, with91: boolean): PackGroup {
  const targets = Array.from({ length: cranks }, () => k());
  const ixs = [...buildExitCrankIxs({ programId, cranker: wallet, market: m.market, targets }), ...(with91 ? [rebalance91(m)] : []), ...execute77(m)];
  return { instructions: ixs, computeUnits: cranks * CU_CRANK + (with91 ? CU_REBALANCE_91 : 0) + CU_EXECUTE_77 };
}

const rows: string[] = [];
function report(label: string, groups: PackGroup[]) {
  const r = measureBundleFormats(groups, wallet, { priorityMicroLamportsPerCu: 100_000, cuHeadroom: 1 });
  const cell = (f: (typeof r)[number]) => (f.txCount === null ? "does not fit" : `${f.txCount} tx [${f.bytes.join(",")} B; ${f.accounts.join(",")} acc; ${f.computeUnits.map((c) => `${Math.round(c / 1000)}k`).join(",")} CU; ${f.signers.join(",")} sig]`);
  rows.push(`${label.padEnd(44)} | legacy ${cell(r[0]!)} | v0 ${cell(r[1]!)} | v1 ${cell(r[2]!)}`);
  return { legacy: r[0]!, v0: r[1]!, v1: r[2]! };
}

describe("(c) Earn exit bundle (R3-M1 cranks + tag 77)", () => {
  const m = newMarket();
  it("the app's bundle (MAX_EXIT_CRANKS cranks + 77, with and without the 91 prefix) is ONE legacy tx", () => {
    expect(MAX_EXIT_CRANKS).toBe(4);
    for (const with91 of [false, true]) {
      for (let n = 0; n <= MAX_EXIT_CRANKS; n++) {
        const r = report(`earn exit: ${n} cranks${with91 ? " + 91" : ""} + 77`, [earnExit(m, n, with91)]);
        expect(r.legacy.txCount).toBe(1);
        expect(r.v1.txCount).toBe(1);
        expect(r.legacy.bytes[0]!).toBeLessThanOrEqual(TX_LEGACY_MAX_BYTES);
      }
    }
  });
  it("CU-bound: the CU ceiling caps cranks per tx at the same number in every format; legacy bytes are not the limit", () => {
    let maxCuFit = 0;
    for (let n = 0; n <= 12; n++) {
      if (n * CU_CRANK + CU_EXECUTE_77 + CU_REBALANCE_91 <= 1_400_000) maxCuFit = n;
    }
    const r = report(`earn exit: ${maxCuFit} cranks (CU max) + 91 + 77`, [earnExit(m, maxCuFit, true)]);
    expect(r.legacy.txCount).toBe(1); // still fits 1,232 B at the CU maximum
    expect(r.v1.txCount).toBe(1);
    const over = report(`earn exit: ${maxCuFit + 1} cranks + 91 + 77`, [earnExit(m, maxCuFit + 1, true)]);
    expect(over.legacy.txCount).toBeNull(); // one atomic group over the CU ceiling: no format fits
    expect(over.v1.txCount).toBeNull();
    // The helper therefore never picks v1 for it in auto.
    const p = planUserBundle({ groups: [earnExit(m, MAX_EXIT_CRANKS, true)], payer: wallet, mode: "auto", walletV1: true, clusterV1: true });
    expect(p.format).toBe("legacy");
    expect(p.reason).toBe("no-benefit");
  });
});

describe("(d) Move to v2.1 (#3148): one action = one tx per step per market", () => {
  const markets = Array.from({ length: 6 }, newMarket);
  it("each single action fits one legacy tx (v1 removes no prompt)", () => {
    const m = markets[0]!;
    const single: Array<[string, PackGroup]> = [
      ["move close (1 leg)", { instructions: closeLeg(m), computeUnits: CU_CLOSE_LEG }],
      ["move withdraw", { instructions: [withdraw(m)], computeUnits: CU_WITHDRAW }],
      ["move earn-request (76)", { instructions: [request76(m)], computeUnits: CU_REQUEST_76 }],
      ["move earn-execute (4 cranks + 77)", earnExit(m, 4, false)],
    ];
    for (const [label, g] of single) {
      const r = report(label, [g]);
      expect(r.legacy.txCount).toBe(1);
      const p = planUserBundle({ groups: [g], payer: wallet, mode: "auto", walletV1: true, clusterV1: true });
      expect(p.format).toBe("legacy");
    }
  });
  it("hypothetical cross-market batching (NOT what the flow does): v1 helps only for byte-bound kinds", () => {
    const byKind: Array<[string, (m: Market) => PackGroup]> = [
      ["x6 markets: earn-request (76)", (m) => ({ instructions: [request76(m)], computeUnits: CU_REQUEST_76 })],
      ["x6 markets: withdraw", (m) => ({ instructions: [withdraw(m)], computeUnits: CU_WITHDRAW })],
      ["x6 markets: close (1 leg)", (m) => ({ instructions: closeLeg(m), computeUnits: CU_CLOSE_LEG })],
      ["x6 markets: earn-execute (0 cranks + 77)", (m) => ({ instructions: execute77(m), computeUnits: CU_EXECUTE_77 })],
    ];
    const out: Record<string, { legacy: number | null; v1: number | null }> = {};
    for (const [label, f] of byKind) {
      const r = report(label, markets.map(f));
      out[label] = { legacy: r.legacy.txCount, v1: r.v1.txCount };
    }
    // closes are CU-bound (3 x 400k per tx): same count in both formats.
    expect(out["x6 markets: close (1 leg)"]!.v1).toBe(out["x6 markets: close (1 leg)"]!.legacy);
    // byte-bound kinds: v1 needs fewer txs.
    expect(out["x6 markets: earn-request (76)"]!.v1!).toBeLessThan(out["x6 markets: earn-request (76)"]!.legacy!);
  });
  it("sizes stay within the format limits", () => {
    expect(TX_V1_MAX_BYTES).toBe(4096);
    if (PRINT) process.stdout.write(["", ...rows, ""].join("\n"));
  });
});
