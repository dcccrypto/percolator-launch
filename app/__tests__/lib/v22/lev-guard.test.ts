// @vitest-environment node
/**
 * v2.2 leverage guard (wrapper tag 124) in the app: the op 0 INIT instruction the launch wizard builds, the tail every TradeCpi /
 * EvictAndTradeCpi carries when the market's guard exists, the existence check and its cache, the launch decision, the single-transaction
 * shape rules for the new instruction, and the error copy for codes 131..135 (with the 133 log reasons). Pure; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError } from "@/lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import {
  LEV_GUARD_MISS_TTL_MS,
  buildLevGuardInitIx,
  levGuardExists,
  levGuardPda,
  planLevGuardLaunch,
  resetLevGuardCache,
  shouldAppendLevGuard,
  withLevGuardTail,
} from "@/lib/v22/lev-guard";
import { LEV_GUARD_COPY, levGuardRefusedCopy, parseLevGuardRefusal } from "@/lib/v22/lev-guard-copy";
import { V22_ERROR_CODE_MAP } from "@/lib/v22/error-copy";
import { WRAPPER_ERR_V22 } from "@/lib/v22/wrapper-errors";
import { PERCOLATOR_ERRORS_V22 } from "@/lib/v22/sdk";
import { buildTradeIxs } from "@/lib/trade-ix";
import { buildP3BindIxs } from "@/lib/limits/p3-wizard";
import { levGuardInitViolations, classifyLaunchIx, expectedLaunchShape, neutralFromInstructions, MARKETAUTH_GATED } from "@/lib/launch-single-tx/shape";
import { LEV_GUARD_ACCOUNT_LEN_V22, LEV_GUARD_OP_V22, TAG_LEV_GUARD_V22, deriveProgramDataV22, levAgeBandV22 } from "@/lib/v22/sdk";

const k = (): PublicKey => Keypair.generate().publicKey;
const ids = resolveDevnetProgramIds();
const PROG = new PublicKey(ids.wrapper);

beforeEach(() => {
  __setDevnetV22ForTest(true);
  resetLevGuardCache();
});
afterEach(() => __setDevnetV22ForTest(null));

// ── the op 0 INIT instruction ───────────────────────────────────────────────────────────────────
describe("buildLevGuardInitIx (launch wizard step)", () => {
  const market = k();
  const creator = k();
  const ix = buildLevGuardInitIx(PROG, market, creator);
  it("is tag 124 op 0 with t0 = 0 (a creator can never backdate)", () => {
    expect(ix.programId.equals(PROG)).toBe(true);
    expect(Buffer.from(ix.data).toString("hex")).toBe("7c000000000000000000");
    expect(ix.data[0]).toBe(TAG_LEV_GUARD_V22);
    expect(ix.data[1]).toBe(LEV_GUARD_OP_V22.Init);
  });
  it("carries [creator s w, program data, market w, guard PDA w, system program] exactly", () => {
    expect(ix.keys).toEqual([
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: deriveProgramDataV22(PROG)[0], isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: levGuardPda(PROG, market), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  });
  it("the guard PDA is [\"lev_guard\", market] under the wrapper", () => {
    expect(levGuardPda(PROG, market).equals(PublicKey.findProgramAddressSync([Buffer.from("lev_guard"), market.toBytes()], PROG)[0])).toBe(true);
  });
  it("the account is 4456 bytes (16 + 344 + 4096) per the ported constants", () => {
    expect(LEV_GUARD_ACCOUNT_LEN_V22).toBe(4456);
  });
  it("age band: no opens under 6 h (54,000 slots), then day", () => {
    expect(levAgeBandV22(100n, 100n + 53_999n)).toBe("NoOpen");
    expect(levAgeBandV22(100n, 100n + 54_000n)).toBe("Day");
  });
});

// ── the bind carries the guard (launch wizard) ──────────────────────────────────────────────────
describe("buildP3BindIxs: the guard rides right after the junior deposit", () => {
  const PROG2 = k(), MARKET = k(), lp = k(), creator = k();
  const base = {
    market: { programId: PROG2, market: MARKET, registry: k(), vaultLpState: k(), lpPortfolio: lp, ledger: k(), siblingLedger: k() },
    creator, vaultLpPortfolio: lp, portfolioLen: 9_435, portfolioRentLamports: 1, matcherProgram: k(), matcherCtx: k(), matcherCtxRentLamports: 2,
    juniorFloorBps: 2_000, juniorAtoms: 7n, creatorAta: k(), vaultToken: k(),
  };
  const growth = { lLaunchX100: 500 };
  it("growth + levGuard: five instructions, the last is op 0 on this market signed by the creator", () => {
    const ixs = buildP3BindIxs({ ...base, growth, levGuard: true });
    expect(ixs).toHaveLength(5);
    const last = ixs[4]!;
    expect(last.programId.equals(PROG2)).toBe(true);
    expect(Array.from(last.data.subarray(0, 2))).toEqual([124, 0]);
    expect(last.keys[0]).toEqual({ pubkey: creator, isSigner: true, isWritable: true });
    expect(last.keys[2]!.pubkey.equals(MARKET)).toBe(true);
    // The bind (94) precedes it: op 0 needs a bound vault LP.
    expect(ixs[2]!.data[0]).not.toBe(124);
  });
  it("no levGuard flag (flag off): the four-instruction bind, byte-identical to before", () => {
    expect(buildP3BindIxs({ ...base, growth })).toHaveLength(4);
    expect(buildP3BindIxs({ ...base })).toHaveLength(4);
  });
  it("levGuard without a growth block adds nothing (the program answers 134 there)", () => {
    expect(buildP3BindIxs({ ...base, levGuard: true })).toHaveLength(4);
  });
});

describe("batched M4p still fits one legacy transaction with the guard", () => {
  it("wallet + 2 fresh keypairs, compute budget + bind + guard: serialized size is under 1232 bytes", () => {
    const PROG2 = k(), MARKET = k(), creator = Keypair.generate(), lpKp = Keypair.generate(), ctxKp = Keypair.generate();
    const mk = (levGuard: boolean): number => {
      const ixs = buildP3BindIxs({
        market: { programId: PROG2, market: MARKET, registry: k(), vaultLpState: k(), lpPortfolio: lpKp.publicKey, ledger: k(), siblingLedger: k() },
        creator: creator.publicKey, vaultLpPortfolio: lpKp.publicKey, portfolioLen: 9_435, portfolioRentLamports: 1, matcherProgram: k(), matcherCtx: ctxKp.publicKey,
        matcherCtxRentLamports: 2, juniorFloorBps: 2_000, juniorAtoms: 7n, creatorAta: k(), vaultToken: k(),
        growth: { lLaunchX100: 500 }, levGuard,
      });
      const tx = new Transaction({ feePayer: creator.publicKey, recentBlockhash: "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS" });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs);
      tx.partialSign(creator, lpKp, ctxKp);
      return tx.serialize().length;
    };
    const without = mk(false);
    const withGuard = mk(true);
    expect(withGuard).toBeGreaterThan(without);
    expect(withGuard).toBeLessThanOrEqual(1232);
  });
});

// ── the launch decision (sequential path / resume) ──────────────────────────────────────────────
describe("planLevGuardLaunch", () => {
  const a = { v22On: true, growth: true, vaultLpBound: true, guardExists: false, poolExists: false, programId: PROG, market: k(), creator: k() };
  it("sends op 0 when the guard is missing and the creator can still sign", () => {
    const p = planLevGuardLaunch(a);
    expect(p.action).toBe("send");
    if (p.action === "send") expect(Array.from(p.ix.data.subarray(0, 2))).toEqual([124, 0]);
  });
  it("skips when the guard exists (a resume)", () => expect(planLevGuardLaunch({ ...a, guardExists: true }).action).toBe("exists"));
  it("is not applicable with the flag off, no growth block, or no bound vault LP", () => {
    expect(planLevGuardLaunch({ ...a, v22On: false }).action).toBe("not-applicable");
    expect(planLevGuardLaunch({ ...a, growth: false }).action).toBe("not-applicable");
    expect(planLevGuardLaunch({ ...a, vaultLpBound: false }).action).toBe("not-applicable");
  });
  it("after the stake pool rotated the market authority the creator can no longer add it", () => {
    expect(planLevGuardLaunch({ ...a, poolExists: true }).action).toBe("authority-rotated");
  });
});

// ── single-transaction shape ────────────────────────────────────────────────────────────────────
describe("single-transaction launch shape: LevGuardInit", () => {
  const programs = { wrapper: PROG.toBase58(), stake: k().toBase58() };
  const slab = k();
  const payer = k();
  const ix = buildLevGuardInitIx(PROG, slab, payer);
  const ctx = { programs, payer: payer.toBase58(), slab: slab.toBase58(), keeper: null };
  const neutral = () => neutralFromInstructions(payer, [ix])[0]!;
  it("is classified (flag on) and not an unknown wrapper ix", () => {
    expect(classifyLaunchIx(neutral(), programs)).toBe("wrapper.LevGuardInit");
  });
  it("flag off: not recognised (a v2.1 deployment treats tag 124 as foreign)", () => {
    __setDevnetV22ForTest(false);
    expect(classifyLaunchIx(neutral(), programs)).toBe("wrapper.other");
  });
  it("only op 0 is the launch's guard instruction", () => {
    const n = neutral();
    n.data = Uint8Array.from([124, 3]);
    expect(classifyLaunchIx(n, programs)).toBe("wrapper.other");
  });
  it("sits after the junior deposit and before the stake rotation", () => {
    const s = expectedLaunchShape({ memo: false, cosign: false, feeSplit: false, levGuard: true });
    expect(s.indexOf("wrapper.LevGuardInit")).toBe(s.indexOf("wrapper.DepositJuniorTranche") + 1);
    expect(s.indexOf("wrapper.LevGuardInit")).toBeLessThan(s.indexOf("stake.InitPool"));
    expect(expectedLaunchShape({ memo: false, cosign: false, feeSplit: false })).not.toContain("wrapper.LevGuardInit");
    expect(MARKETAUTH_GATED).toContain("wrapper.LevGuardInit");
  });
  it("the real instruction passes", () => expect(levGuardInitViolations(neutral(), 0, ctx)).toEqual([]));
  it("NEGATIVE: a backdated t0, another market, another payer, or extra accounts are refused", () => {
    const backdated = neutral();
    backdated.data = Uint8Array.from([124, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(levGuardInitViolations(backdated, 0, ctx).join("|")).toMatch(/t0 = 0/);
    expect(levGuardInitViolations(neutral(), 0, { ...ctx, slab: k().toBase58() }).join("|")).toMatch(/account \[2\]/);
    expect(levGuardInitViolations(neutral(), 0, { ...ctx, payer: k().toBase58() }).join("|")).toMatch(/account \[0\]/);
    const extra = neutral();
    extra.accounts = [...extra.accounts, extra.accounts[0]!];
    expect(levGuardInitViolations(extra, 0, ctx).join("|")).toMatch(/6 accounts/);
  });
});

// ── trading: the guard tail ─────────────────────────────────────────────────────────────────────
describe("TradeCpi guard tail", () => {
  const market = k();
  const fixed = { signer: k(), accountA: k(), accountB: k(), matcherProg: k(), matcherCtx: k(), matcherDelegate: k() };
  const tradeParams = (levGuard?: boolean) => ({
    programId: PROG, market, ...fixed,
    takerId: { portfolioId: 1n, positionEpoch: 0n }, lpId: { portfolioId: 2n, positionEpoch: 0n, matcherSequence: 0n },
    marketId: 1n, legs: [10n], size: 10n, limitPriceE6: 1_000_000n, feeBps: 30n, ...(levGuard === undefined ? {} : { levGuard }),
  });
  const guard = levGuardPda(PROG, market);

  it("decision: only TradeCpi (10) / EvictAndTradeCpi (119), only when the guard exists", () => {
    expect(shouldAppendLevGuard(true, Uint8Array.from([10]))).toBe(true);
    expect(shouldAppendLevGuard(true, Uint8Array.from([119]))).toBe(true);
    expect(shouldAppendLevGuard(true, Uint8Array.from([3]))).toBe(false);
    expect(shouldAppendLevGuard(false, Uint8Array.from([10]))).toBe(false);
    expect(shouldAppendLevGuard(true, Uint8Array.from([]))).toBe(false);
  });
  it("guard exists: every leg's TradeCpi ends with the guard, writable, not a signer", () => {
    const ixs = buildTradeIxs({ ...tradeParams(true), legs: [4n, 6n] });
    expect(ixs).toHaveLength(2);
    for (const ix of ixs) {
      const last = ix.keys[ix.keys.length - 1]!;
      expect(last).toEqual({ pubkey: guard, isSigner: false, isWritable: true });
      expect(ix.keys).toHaveLength(8); // 7 TradeCpi accounts + the guard
    }
  });
  it("no guard (or the flag omitted): the instruction is byte-identical to before", () => {
    const plain = buildTradeIxs(tradeParams())[0]!;
    const off = buildTradeIxs(tradeParams(false))[0]!;
    expect(plain.keys).toHaveLength(7);
    expect(off.keys).toEqual(plain.keys);
    expect(Buffer.from(off.data).equals(Buffer.from(plain.data))).toBe(true);
    expect(plain.keys.some((m) => m.pubkey.equals(guard))).toBe(false);
  });
  it("with the guard the data and the first 7 accounts are unchanged", () => {
    const plain = buildTradeIxs(tradeParams(false))[0]!;
    const withG = buildTradeIxs(tradeParams(true))[0]!;
    expect(withG.keys.slice(0, 7)).toEqual(plain.keys);
    expect(Buffer.from(withG.data).equals(Buffer.from(plain.data))).toBe(true);
  });
  it("is idempotent, and rejects a non-trade instruction", () => {
    const once = buildTradeIxs(tradeParams(true))[0]!;
    expect(withLevGuardTail(once, market, true)).toBe(once);
    const other = new TransactionInstruction({ programId: PROG, keys: once.keys, data: Buffer.from([3]) });
    expect(withLevGuardTail(other, market, true)).toBe(other);
  });
});

// ── existence check and cache ───────────────────────────────────────────────────────────────────
describe("levGuardExists", () => {
  const market = k();
  const guardInfo = (owner: PublicKey) => ({ owner, data: Buffer.alloc(4456), lamports: 1, executable: false });
  it("true only for a wrapper-owned account; a hit is cached for good (one RPC)", async () => {
    const get = vi.fn(async () => guardInfo(PROG) as never);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market)).toBe(true);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("a funded stranger at the guard address does not count", async () => {
    const get = vi.fn(async () => guardInfo(SystemProgram.programId) as never);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market)).toBe(false);
  });
  it("a miss is cached briefly, then asked again (the creator may add it a moment later)", async () => {
    let t = 1_000;
    const get = vi.fn(async () => null);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market, () => t)).toBe(false);
    t += LEV_GUARD_MISS_TTL_MS - 1;
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market, () => t)).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    t += 2;
    get.mockResolvedValueOnce(guardInfo(PROG) as never);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market, () => t)).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("an RPC failure is retried once, then answers false WITHOUT caching it", async () => {
    const get = vi.fn().mockRejectedValue(new Error("rpc down"));
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market)).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
    get.mockReset();
    get.mockResolvedValue(guardInfo(PROG) as never);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market)).toBe(true);
  });
  it("is per market", async () => {
    const get = vi.fn(async (pk: PublicKey) => (pk.equals(levGuardPda(PROG, market)) ? (guardInfo(PROG) as never) : null));
    expect(await levGuardExists({ getAccountInfo: get }, PROG, market)).toBe(true);
    expect(await levGuardExists({ getAccountInfo: get }, PROG, k())).toBe(false);
  });
});

// ── error copy ──────────────────────────────────────────────────────────────────────────────────
describe("errors 131..135", () => {
  const fail = (code: number, logs?: string[]) => {
    const e = new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`) as Error & { programId: string | null; logs?: string[] };
    e.programId = ids.wrapper;
    if (logs) e.logs = logs;
    return e;
  };
  const raw = (code: number, extra = ""): string =>
    `Transaction simulation failed: custom program error: 0x${code.toString(16)}\n${extra}\nProgram ${ids.wrapper} failed: custom program error: 0x${code.toString(16)}`;
  const log = (why: string) => `Program log: lev_guard_refused ${why}`;
  const JARGON = /\b(tag \d+|Custom\(|PDA|0x[0-9a-f]+)\b/i;

  it("the code table has the five names the program uses", () => {
    expect([WRAPPER_ERR_V22.CreatorStakeBelowMinimum, WRAPPER_ERR_V22.LevGuardRequired, WRAPPER_ERR_V22.LevGuardRefused, WRAPPER_ERR_V22.LevGuardInvalid, WRAPPER_ERR_V22.LpStopNotTriggered]).toEqual([131, 132, 133, 134, 135]);
    for (const c of [131, 132, 133, 134, 135]) expect(PERCOLATOR_ERRORS_V22[c]?.name).toBeTruthy();
  });
  it("131: creator stake at least $500", () => {
    expect(resolveUserMessage(fail(131), { surface: "any" }).body).toMatch(/at least \$500/);
    expect(humanizeError(raw(131))).toBe(LEV_GUARD_COPY.creatorStake);
  });
  it("132: needs its safety guard account; refresh / out of date, with a refresh action", () => {
    const m = resolveUserMessage(fail(132), { surface: "trade" });
    expect(m.body).toMatch(/safety guard account/);
    expect(m.body).toMatch(/Refresh the page/);
    expect(m.body).toMatch(/out of date/);
    expect(m.action?.id).toBe("refresh");
    expect(humanizeError(raw(132))).toBe(LEV_GUARD_COPY.required);
  });
  it.each([
    ["age_under_6h", /new token: opening positions unlocks 6 hours after launch/i],
    ["leverage", /leverage is above/i],
    ["size", /bigger than/i],
    ["short_dump_cap", /shorts are capped/i],
    ["lp_stop_round", /LP is rebalancing after a loss; try again shortly/i],
  ])("133 with the log reason %s names the cause (structured and plain)", (why, re) => {
    const structured = resolveUserMessage(fail(133, [log(why)]), { surface: "trade" });
    expect(structured.body).toMatch(re);
    expect(structured.kind).toBe(`lev-guard-${why}`);
    expect(humanizeError(raw(133, log(why)))).toMatch(re);
    expect(`${structured.title} ${structured.body}`).not.toMatch(JARGON);
  });
  it("133: the age and LP-round causes are waits, the rest ask for a different order", () => {
    expect(resolveUserMessage(fail(133, [log("age_under_6h")]), { surface: "trade" }).variant).toBe("wait");
    expect(resolveUserMessage(fail(133, [log("lp_stop_round")]), { surface: "trade" }).variant).toBe("wait");
    expect(resolveUserMessage(fail(133, [log("leverage")]), { surface: "trade" }).variant).toBe("error");
  });
  it("133 with no log (or an unknown reason) falls back to one line that covers every cause", () => {
    for (const logs of [undefined, [log("something_new")]]) {
      const m = resolveUserMessage(fail(133, logs), { surface: "trade" });
      expect(m.body).toBe(levGuardRefusedCopy(null));
      expect(m.body).toMatch(/safety guard declined/);
    }
    expect(humanizeError(raw(133))).toBe(levGuardRefusedCopy(null));
  });
  it("the reason can ride in the raw message text too (wallet error with logs inlined)", () => {
    const e = fail(133);
    e.message += `\n${log("size")}`;
    expect(resolveUserMessage(e, { surface: "trade" }).body).toMatch(/bigger than/);
  });
  it("134 and 135 have plain lines", () => {
    expect(resolveUserMessage(fail(134), { surface: "any" }).body).toBe(LEV_GUARD_COPY.invalid);
    expect(resolveUserMessage(fail(135), { surface: "any" }).body).toBe(LEV_GUARD_COPY.lpStopNotTriggered);
    expect(V22_ERROR_CODE_MAP[134]).toBe(LEV_GUARD_COPY.invalid);
    expect(V22_ERROR_CODE_MAP[135]).toBe(LEV_GUARD_COPY.lpStopNotTriggered);
  });
  it("all copy is one calm line without protocol vocabulary", () => {
    const all = [LEV_GUARD_COPY.creatorStake, LEV_GUARD_COPY.required, LEV_GUARD_COPY.invalid, LEV_GUARD_COPY.lpStopNotTriggered, ...Object.values(LEV_GUARD_COPY.refused)];
    for (const t of all) {
      expect(t).not.toMatch(/\n/);
      expect(t).not.toMatch(JARGON);
    }
  });
  it("parseLevGuardRefusal reads a log array, a joined string, and ignores noise", () => {
    expect(parseLevGuardRefusal(["Program log: x", log("leverage")])).toBe("leverage");
    expect(parseLevGuardRefusal(`a\n${log("size")}\nb`)).toBe("size");
    expect(parseLevGuardRefusal("nothing here")).toBeNull();
    expect(parseLevGuardRefusal(null)).toBeNull();
    expect(parseLevGuardRefusal(log("bogus"))).toBeNull();
  });
  it("flag off: the guard codes are not interpreted (v2.1 build reads wrapper codes only up to its own table)", () => {
    __setDevnetV22ForTest(false);
    expect(resolveUserMessage(fail(132), { surface: "trade" }).kind).not.toBe("lev-guard-required");
  });
});
