// @vitest-environment node
/**
 * Resolved-market Earn exit (F-4 / P3-H1), the P3 wizard, the pre-resolve bound tail and the
 * F-7 close notice. Bytes are written at the rustc offset_of! offsets (rust-p3-final.json).
 * The planner + exitStepIxs also run end to end on real BPF in scripts/limits-parity/p3-sim.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { decodeResolvedMarket, decodeResolvedPortfolio } from "@/lib/limits/decode";
import { batchExitSteps, looksEmpty, planResolvedExit, summarizeResolvedExit, type ExitPortfolio } from "@/lib/limits/resolved-exit";
import { runResolvedExit, type ResolvedExitDeps } from "@/lib/limits/resolved-exit-run";
import { exitStepIxs } from "@/lib/limits/resolved-exit-ixs";
import { buildP3BindIxs, juniorFloorAtoms, maxWizardFloorBps, p3BindProgress, validateP3Wizard, wizardP3Params, canonicalVaultLpMatcher } from "@/lib/limits/p3-wizard";
import { deriveVaultLpState } from "@/lib/limits/p3-ix";
import { buildLpCrankIx, decideLpLeg } from "@/lib/pre-resolve";
import { closeLimitNotice } from "@/lib/limits/ticket";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { afterLegsShift, blankMarket, blankPortfolio } from "../../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";


const k = () => Keypair.generate().publicKey;
function marketBytes(o: { mode: number; cTot?: bigint; count?: bigint; resolvedSlot?: bigint; delay?: bigint }): Uint8Array {
  const d = blankMarket();
  const v = new DataView(d.buffer);
  const M = marketOffsets(d);
  d[M.hdr(C.H_MODE)] = o.mode;
  v.setBigUint64(M.hdr(C.H_C_TOT), o.cTot ?? 0n, true);
  v.setBigUint64(M.hdr(C.H_MATERIALIZED_PORTFOLIO_COUNT), o.count ?? 0n, true);
  v.setBigUint64(M.hdr(C.H_RESOLVED_SLOT), o.resolvedSlot ?? 100n, true);
  v.setBigUint64(C.HEADER_LEN + C.WCFG_FORCE_CLOSE_DELAY_SLOTS, o.delay ?? 0n, true);
  return d;
}
function portfolioBytes(o: { capital?: bigint; bitmap?: bigint; receipt?: [boolean, boolean]; rebalanceLock?: boolean }): Uint8Array {
  const d = new Uint8Array(blankPortfolio());
  const v = new DataView(d.buffer);
  d[10] = C.KIND_PORTFOLIO;
  v.setBigUint64(C.PF_CAPITAL, o.capital ?? 0n, true);
  v.setBigUint64(C.PF_ACTIVE_BITMAP, o.bitmap ?? 0n, true);
  if (o.receipt) {
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_PRESENT] = o.receipt[0] ? 1 : 0;
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_FINALIZED] = o.receipt[1] ? 1 : 0;
  }
  if (o.rebalanceLock) d[C.PF_REBALANCE_LOCK + afterLegsShift()] = 1;
  return d;
}
const pf = (key: string, o: Parameters<typeof portfolioBytes>[0], x: Partial<ExitPortfolio> = {}): ExitPortfolio => {
  const view = decodeResolvedPortfolio(portfolioBytes(o));
  if (!view) throw new Error("decode");
  return { key, view, escrowed: false, isVaultLp: false, ...x };
};

describe("decoders at the oracle offsets", () => {
  it("market: mode / c_tot / materialized count / resolved slot / force-close delay", () => {
    const m = decodeResolvedMarket(marketBytes({ mode: 1, cTot: 7n, count: 3n, resolvedSlot: 55n, delay: 9n }));
    expect(m).toMatchObject({ mode: 1, cTot: 7n, materializedPortfolioCount: 3n, resolvedSlot: 55n, forceCloseDelaySlots: 9n });
  });
  it("portfolio: emptiness subset + receipt; non-portfolio kind => null", () => {
    const p = decodeResolvedPortfolio(portfolioBytes({ capital: 5n, receipt: [true, false] }));
    expect(p).toMatchObject({ capital: 5n, receiptPresent: true, receiptFinalized: false });
    const bad = portfolioBytes({});
    bad[10] = C.KIND_MARKET_ACCOUNT;
    expect(decodeResolvedPortfolio(bad)).toBeNull();
    expect(looksEmpty(decodeResolvedPortfolio(portfolioBytes({}))!)).toBe(true);
    expect(looksEmpty(decodeResolvedPortfolio(portfolioBytes({ receipt: [true, false] }))!)).toBe(false);
    expect(looksEmpty(decodeResolvedPortfolio(portfolioBytes({ receipt: [true, true] }))!)).toBe(true);
  });
});

describe("planResolvedExit", () => {
  const base = { nowSlot: 1_000n, boundVault: true, harvestableAtoms: 0n };
  it("live market => not-resolved", () => {
    expect(planResolvedExit({ ...base, market: decodeResolvedMarket(marketBytes({ mode: 0 }))!, portfolios: [] })).toEqual({ phase: "not-resolved" });
  });
  it("vault LP first, traders alongside: a vault LP that WON can only settle once traders detach", () => {
    // 5544302a real BPF (limits_app_p3_partial_receipt_topup_after_101): holding traders until the
    // vault LP settled never finished a market whose vault LP won (every 101 progress-only).
    const market = decodeResolvedMarket(marketBytes({ mode: 1, cTot: 10n, count: 2n }))!;
    const plan = planResolvedExit({ ...base, market, portfolios: [pf("V", { capital: 5n, bitmap: 1n }, { isVaultLp: true }), pf("T", { capital: 5n, bitmap: 1n })] });
    expect(plan).toEqual({
      phase: "sweep",
      steps: [
        { kind: "settle-vault-lp", topup: 0, portfolio: "V" },
        { kind: "close-resolved", portfolio: "T" },
      ],
      blockers: [],
    });
  });
  it("then: empty vault LP closed (owner = registry), trader close-resolved; receipts get their top-up; empties close", () => {
    const market = decodeResolvedMarket(marketBytes({ mode: 1, cTot: 10n, count: 4n }))!;
    const plan = planResolvedExit({
      ...base,
      market,
      portfolios: [pf("V", {}, { isVaultLp: true }), pf("T", { capital: 5n }), pf("R", { receipt: [true, false] }), pf("E", {})],
    });
    expect(plan.phase).toBe("sweep");
    if (plan.phase !== "sweep") return;
    expect(plan.steps).toEqual([
      { kind: "close-empty", portfolio: "V", isVaultLp: true },
      { kind: "close-resolved", portfolio: "T" },
      { kind: "claim-topup", portfolio: "R" },
      { kind: "close-empty", portfolio: "E", isVaultLp: false },
    ]);
  });
  it("owner window: only empties close; traders + the 101 close step wait until resolved_slot + delay", () => {
    const market = decodeResolvedMarket(marketBytes({ mode: 1, cTot: 1n, count: 2n, resolvedSlot: 900n, delay: 500n }))!;
    const plan = planResolvedExit({ ...base, market, portfolios: [pf("V", { capital: 1n, bitmap: 1n }, { isVaultLp: true }), pf("E", {})] });
    expect(plan).toEqual({ phase: "owner-window", untilSlot: 1_400n, steps: [{ kind: "close-empty", portfolio: "E", isVaultLp: false }], blockers: [] });
  });
  it("escrowed (NFT) and locked portfolios are blockers, never sent unsigned", () => {
    const market = decodeResolvedMarket(marketBytes({ mode: 1, cTot: 1n, count: 2n }))!;
    const plan = planResolvedExit({ ...base, boundVault: false, market, portfolios: [pf("N", { capital: 1n }, { escrowed: true }), pf("L", { capital: 1n, rebalanceLock: true })] });
    expect(plan).toEqual({ phase: "sweep", steps: [], blockers: [{ kind: "escrowed", portfolio: "N" }, { kind: "locked", portfolio: "L" }] });
  });
  it("terminal-flat => ready; a BOUND vault with fees pending first gets the 78 harvest step (07a1d0eb)", () => {
    const market = decodeResolvedMarket(marketBytes({ mode: 1 }))!;
    expect(planResolvedExit({ ...base, market, portfolios: [] })).toEqual({ phase: "ready", blockers: [] });
    const h = planResolvedExit({ ...base, harvestableAtoms: 42n, market, portfolios: [] });
    expect(h).toEqual({ phase: "sweep", steps: [{ kind: "harvest" }], blockers: [] });
    expect(summarizeResolvedExit(h)).toMatchObject({ phase: "sweep", runnable: 1 });
    // an unbound (legacy) vault has no Resolved harvest: straight to ready
    expect(planResolvedExit({ ...base, boundVault: false, harvestableAtoms: 42n, market, portfolios: [] }).phase).toBe("ready");
    // not terminal-flat yet: no harvest step (78 would be refused 21)
    const busy = decodeResolvedMarket(marketBytes({ mode: 1, cTot: 1n, count: 1n }))!;
    const p = planResolvedExit({ ...base, harvestableAtoms: 42n, market: busy, portfolios: [pf("E", {})] });
    expect(p.phase === "sweep" && p.steps.some((x) => x.kind === "harvest")).toBe(false);
  });
  it("batching keeps order, <= perTx per tx", () => {
    const s = [1, 2, 3, 4, 5].map((i) => ({ kind: "close-empty" as const, portfolio: String(i), isVaultLp: false }));
    expect(batchExitSteps(s, 2).map((b) => b.map((x) => x.portfolio))).toEqual([["1", "2"], ["3", "4"], ["5"]]);
  });
});

describe("runResolvedExit (injected deps)", () => {
  const step = (p: string) => ({ kind: "close-empty" as const, portfolio: p, isVaultLp: false });
  it("a batch that fails sim is split; the good step is sent, the bad one reported; re-plans until ready", async () => {
    let round = 0;
    const sent: string[][] = [];
    const deps: ResolvedExitDeps = {
      plan: async () => (round++ === 0 ? { phase: "sweep", steps: [step("A"), step("B")], blockers: [] } : { phase: "ready", blockers: [] }),
      ixsFor: (s) => [{ programId: PublicKey.default, keys: [], data: Buffer.from(("portfolio" in s ? s.portfolio : "")) }],
      simulate: async (ixs) => (ixs.some((i) => i.data.toString() === "B") ? { InstructionError: [0, { Custom: 8 }] } : null),
      send: async (ixs) => {
        sent.push(ixs.map((i) => i.data.toString()));
        return `sig${sent.length}`;
      },
    };
    const r = await runResolvedExit(deps);
    expect(sent).toEqual([["A"]]);
    expect(r.refused.map((x) => ("portfolio" in x.step ? x.step.portfolio : ""))).toEqual(["B"]);
    expect(r.final.phase).toBe("ready");
  });
  it("stops when a round makes no progress (never loops on a refused step)", async () => {
    let plans = 0;
    const deps: ResolvedExitDeps = {
      plan: async () => {
        plans += 1;
        return { phase: "sweep", steps: [step("X")], blockers: [] };
      },
      ixsFor: () => [],
      simulate: async () => "refused",
      send: async () => "never",
    };
    const r = await runResolvedExit(deps);
    expect(r.rounds).toBe(1);
    expect(plans).toBe(2);
    expect(r.signatures).toEqual([]);
  });
});

describe("exitStepIxs", () => {
  const PROG = k(), MARKET = k(), mint = k(), payer = k();
  const owner = k();
  const ctx = {
    payer, collateralMint: mint, vaultToken: k(), vaultAuthority: k(), programId: PROG, market: MARKET,
    portfolios: new Map([["P", { owner, portfolioId: 3n, matcherSequence: 4n, positionEpoch: 5n }]]),
    vault: null,
  };
  it("close-resolved = [create the OWNER's ATA idempotently (payer pays), permissionless 30 paying that ATA]", () => {
    const key = k().toBase58();
    const ixs = exitStepIxs({ kind: "close-resolved", portfolio: key }, { ...ctx, portfolios: new Map([[key, ctx.portfolios.get("P")!]]) });
    expect(ixs).toHaveLength(2);
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    expect(ixs[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0].keys[0].pubkey.equals(payer)).toBe(true);
    expect(ixs[0].keys[1].pubkey.equals(ata)).toBe(true);
    expect(ixs[0].data[0]).toBe(1); // CreateIdempotent
    expect(ixs[1].data[0]).toBe(C.TAG_CLOSE_RESOLVED);
    expect(ixs[1].keys[0]).toEqual({ pubkey: owner, isSigner: false, isWritable: false });
    expect(ixs[1].keys[3].pubkey.equals(ata)).toBe(true);
  });
  it("close-empty = [8] with the RECORDED owner as rent destination", () => {
    const key = k().toBase58();
    const ixs = exitStepIxs({ kind: "close-empty", portfolio: key, isVaultLp: false }, { ...ctx, portfolios: new Map([[key, ctx.portfolios.get("P")!]]) });
    expect(ixs).toHaveLength(1);
    expect(ixs[0].keys[3].pubkey.equals(owner)).toBe(true);
    expect(ixs[0].data[0]).toBe(C.TAG_CLOSE_PORTFOLIO);
  });
  it("harvest (07a1d0eb) = 78 on the registry's own domain with the bound tail [6]", () => {
    const vault = { programId: PROG, market: MARKET, registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k(), juniorOwner: k(), domain: 1 };
    const [i78] = exitStepIxs({ kind: "harvest" }, { ...ctx, vault });
    expect(i78.data[0]).toBe(C.TAG_LP_VAULT_CRANK_FEES);
    expect(Buffer.from(i78.data).readUInt16LE(1)).toBe(1);
    expect(i78.keys).toHaveLength(7);
    expect(i78.keys[6]).toEqual({ pubkey: vault.vaultLpState, isSigner: false, isWritable: true });
    expect(() => exitStepIxs({ kind: "harvest" }, ctx)).toThrow();
  });
  it("settle-vault-lp without a bound vault is a programming error", () => {
    expect(() => exitStepIxs({ kind: "settle-vault-lp", topup: 0, portfolio: "V" }, ctx)).toThrow();
  });
});

describe("P3 wizard", () => {
  it("floor atoms = ceil(C * floor / 1e4)", () => {
    expect(juniorFloorAtoms(1_000n, 2_000)).toBe(200n);
    expect(juniorFloorAtoms(1_001n, 2_000)).toBe(201n);
  });
  it("validation: floor range, junior > 0, junior >= floor of the seed NAV", () => {
    expect(validateP3Wizard({ juniorFloorBps: 999, juniorAtoms: 1n, seedNavAtoms: 0n })).toBe("floor-out-of-range");
    expect(validateP3Wizard({ juniorFloorBps: 10_001, juniorAtoms: 1n, seedNavAtoms: 0n })).toBe("floor-out-of-range");
    expect(validateP3Wizard({ juniorFloorBps: 1_000, juniorAtoms: 0n, seedNavAtoms: 0n })).toBe("junior-zero");
    expect(validateP3Wizard({ juniorFloorBps: 5_000, juniorAtoms: 499n, seedNavAtoms: 1_000n })).toBe("junior-below-floor");
    expect(validateP3Wizard({ juniorFloorBps: 5_000, juniorAtoms: 500n, seedNavAtoms: 1_000n })).toBeNull();
  });
  it("junior == Liquidity; the max floor for a 2x seed is 50%", () => {
    expect(wizardP3Params(false, 10n, 2_000)).toBeUndefined();
    expect(wizardP3Params(true, 10n, 2_000)).toEqual({ juniorFloorBps: 2_000, juniorAtoms: 10n });
    expect(maxWizardFloorBps(1_000n, 2_000n)).toBe(5_000);
  });
  it("bind ixs: [createAccount(LP), createAccount(ctx, owner = canonical matcher, 320 B), 94 auto-pin (11 accounts), 96]", () => {
    const PROG = k(), MARKET = k(), lp = k(), creator = k(), ctx = k(), registry = k();
    const matcher = canonicalVaultLpMatcher(C.CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET);
    const ixs = buildP3BindIxs({
      market: { programId: PROG, market: MARKET, registry, vaultLpState: deriveVaultLpState(PROG, MARKET), lpPortfolio: lp, ledger: k(), siblingLedger: k() },
      creator, vaultLpPortfolio: lp, portfolioLen: 9_435, portfolioRentLamports: 1, matcherProgram: matcher, matcherCtx: ctx, matcherCtxRentLamports: 2,
      juniorFloorBps: 2_000, juniorAtoms: 7n, creatorAta: k(), vaultToken: k(),
    });
    expect(ixs.map((i) => (i.programId.equals(PROG) ? i.data[0] : "system"))).toEqual(["system", "system", C.P3_TAG.InitVaultLp, C.P3_TAG.DepositJuniorTranche]);
    // createAccount(ctx): SystemProgram data = [u32 2][u64 lamports][u64 space][pubkey owner]
    const ca = Buffer.from(ixs[1].data);
    expect(ca.readUInt32LE(0)).toBe(0);
    expect(Number(ca.readBigUInt64LE(12))).toBe(C.VAULT_LP_MATCHER_CTX_LEN);
    expect(new PublicKey(ca.subarray(20, 52)).equals(matcher)).toBe(true);
    const i94 = ixs[2];
    expect(i94.keys).toHaveLength(11);
    expect(i94.keys[0]).toEqual({ pubkey: creator, isSigner: true, isWritable: true });
    expect(i94.keys[8]).toEqual({ pubkey: matcher, isSigner: false, isWritable: false });
    expect(i94.keys[9]).toEqual({ pubkey: ctx, isSigner: false, isWritable: true });
    const enc = new TextEncoder();
    const del = PublicKey.findProgramAddressSync([enc.encode("matcher"), MARKET.toBytes(), lp.toBytes(), registry.toBytes(), matcher.toBytes(), ctx.toBytes()], PROG)[0];
    expect(i94.keys[10]).toEqual({ pubkey: del, isSigner: false, isWritable: false });
    expect(Buffer.from(i94.data).toString("hex")).toBe("5ed007");
  });
  it("only the canonical matcher can be bound (tag 94 refuses others with 81)", () => {
    expect(() => canonicalVaultLpMatcher(k().toBase58())).toThrow(/canonical/);
  });

  it("resume: bind -> deposit-junior -> done", () => {
    expect(p3BindProgress({ exists: false, juniorDepositedAtoms: null })).toBe("bind");
    expect(p3BindProgress({ exists: true, juniorDepositedAtoms: 0n })).toBe("deposit-junior");
    expect(p3BindProgress({ exists: true, juniorDepositedAtoms: 5n })).toBe("done");
  });
});

describe("pre-resolve 78 on a P3 bound vault", () => {
  const PROG = k(), MARKET = k(), c = k();
  it("appends the vault-LP state at [6] when bound; 6 accounts when not", () => {
    expect(buildLpCrankIx(PROG, c, MARKET, 0).keys).toHaveLength(6);
    const b = buildLpCrankIx(PROG, c, MARKET, 0, true);
    expect(b.keys).toHaveLength(7);
    expect(b.keys[6]).toEqual({ pubkey: deriveVaultLpState(PROG, MARKET), isSigner: false, isWritable: true });
  });
  it("a bound vault with no seniors still cranks (L1 credits the junior); unbound with no depositors is stuck", () => {
    expect(decideLpLeg(5n, { domain: 0, sharesOutstanding: 0n, bound: true })).toEqual({ action: "crank", domain: 0 });
    expect(decideLpLeg(5n, { domain: 0, sharesOutstanding: 0n })).toMatchObject({ action: "stuck" });
  });
});

describe("F-7 close notice (P1 99165722)", () => {
  const lim = (maxQ: bigint, reason: "lp-halt" | "lp-exposure" | "none", halted = false) => ({ maxQ, reason, halted });
  it("long closes on the short side: halted => refused; capped below |pos| => partial; else none", () => {
    expect(closeLimitNotice(100n, { long: lim(UNLIMITED_CAPACITY, "none"), short: lim(0n, "lp-halt", true) })).toEqual({ kind: "halted" });
    expect(closeLimitNotice(100n, { long: lim(UNLIMITED_CAPACITY, "none"), short: lim(40n, "lp-exposure") })).toEqual({ kind: "capped", maxQ: 40n });
    expect(closeLimitNotice(100n, { long: lim(0n, "lp-halt", true), short: lim(UNLIMITED_CAPACITY, "none") })).toBeNull();
    expect(closeLimitNotice(-100n, { long: lim(10n, "lp-exposure"), short: lim(UNLIMITED_CAPACITY, "none") })).toEqual({ kind: "capped", maxQ: 10n });
    expect(closeLimitNotice(0n, null)).toBeNull();
  });
});
