/**
 * ConvertReleasedPnl (tag 28) — math mirror + instruction + quote.
 *
 * Vectors are derived from the handler (deployed wrapper bd4fe5f8 src/v16_program.rs:19942-19977,
 * engine 35ddd692 src/v16.rs:19858-19890 + 11094-11215) and, where marked DEVNET, from
 * simulations of the real instruction against wrapper ETDLAdi… on 2026-10-01.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import type { PortfolioSourceDomainV17 } from "@percolatorct/sdk";
import {
  BOUND_SCALE,
  CREDIT_RATE_SCALE,
  accountSourceRealizableSupport,
  WITHDRAW_EXCEEDS_BALANCE_MESSAGE,
  WithdrawRefusal,
  buildConvertReleasedPnlIx,
  convertCap,
  convertPrefixForWithdraw,
  convertGate,
  planWithdraw,
  quoteConvertible,
  pendingProfit,
  releasedPnlFace,
  settlingProfitMessage,
  simulateConvertMath,
  type QuoteDeps,
  type SourceDomainMarketState,
} from "@/lib/convert-released-pnl";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const emptySlot = (): PortfolioSourceDomainV17 => ({
  domain: 0,
  sourceClaimMarketId: 0n,
  sourceClaimBoundNum: 0n,
  sourceClaimLienedNum: 0n,
  sourceClaimCounterpartyLienedNum: 0n,
  sourceClaimInsuranceLienedNum: 0n,
  sourceLienEffectiveReserved: 0n,
  sourceLienCounterpartyBackingNum: 0n,
  sourceLienInsuranceBackingNum: 0n,
  sourceLienFeeLastSlot: 0n,
  sourceClaimImpairedNum: 0n,
  sourceLienImpairedEffectiveReserved: 0n,
  sourceLienCapitalAtRiskFeeRevenue: 0n,
  sourceLienImpairedCapitalAtRiskFeeRevenue: 0n,
});
const slot = (o: Partial<PortfolioSourceDomainV17>): PortfolioSourceDomainV17 => ({ ...emptySlot(), ...o });
const flat: { active: boolean; assetIndex: number; side: number }[] = [];
/** A domain with full credit and ample backing: support == face. */
const ample: SourceDomainMarketState = {
  counterpartyBucketFresh: true,
  creditRateNum: CREDIT_RATE_SCALE,
  positiveClaimBoundNum: 10n ** 30n,
  freshReservedBackingNum: 10n ** 30n,
  validLienedBackingNum: 0n,
  insuranceCreditReservedNum: 0n,
  validLienedInsuranceNum: 0n,
  impairedLienedInsuranceNum: 0n,
};
const all = () => ample;

describe("releasedPnlFace — v16.rs:19863-19864", () => {
  it("is max(pnl,0) − reserved_pnl, saturating", () => {
    expect(releasedPnlFace(384_788n, 0n)).toBe(384_788n);
    expect(releasedPnlFace(1_000n, 400n)).toBe(600n);
    expect(releasedPnlFace(1_000n, 1_000n)).toBe(0n);
    expect(releasedPnlFace(1_000n, 5_000n)).toBe(0n);
    expect(releasedPnlFace(-7n, 0n)).toBe(0n);
    expect(releasedPnlFace(0n, 0n)).toBe(0n);
  });
});

describe("pendingProfit: what both Portfolio Value tiles add for a flat account", () => {
  const pos = (positionSize: bigint, pnl: bigint, reservedPnl = 0n) => ({ account: { positionSize, pnl, reservedPnl } });
  it("a flat account's released pnl counts", () => {
    expect(pendingProfit(pos(0n, 20_000_000n))).toBe(20_000_000n);
    expect(pendingProfit(pos(0n, 20_000_000n, 5_000_000n))).toBe(15_000_000n);
  });
  it("an open position's pnl is not counted (it is in unrealized PnL already)", () => {
    expect(pendingProfit(pos(1_000_000n, 20_000_000n))).toBe(0n);
    expect(pendingProfit(pos(-1_000_000n, 20_000_000n))).toBe(0n);
  });
  it("a u64::MAX sentinel pnl and a missing account are not profit", () => {
    expect(pendingProfit(pos(0n, 2n ** 64n - 1n))).toBe(0n);
    expect(pendingProfit({})).toBe(0n);
  });
});

describe("convertGate — v16.rs:19865-19883 portfolio-side gates", () => {
  const claim = (domain: number, face: bigint) => slot({ domain, sourceClaimBoundNum: face * BOUND_SCALE });
  it("nothing released → nothing", () => {
    expect(convertGate({ pnl: 0n, reservedPnl: 0n, sourceDomains: [claim(0, 5n)], legs: flat }).kind).toBe("nothing");
    expect(convertGate({ pnl: 10n, reservedPnl: 10n, sourceDomains: [claim(0, 10n)], legs: flat }).kind).toBe("nothing");
  });
  it("no source claims in Live → unbacked (converts 0 → LockActive)", () => {
    expect(convertGate({ pnl: 10n, reservedPnl: 0n, sourceDomains: [], legs: flat })).toEqual({ kind: "unbacked", released: 10n });
  });
  it("source claims + a lien → locked", () => {
    const s = slot({ domain: 0, sourceClaimBoundNum: 10n * BOUND_SCALE, sourceClaimLienedNum: 1n });
    expect(convertGate({ pnl: 10n, reservedPnl: 0n, sourceDomains: [s], legs: flat }).kind).toBe("locked");
  });
  it("active exposure is OPPOSITE-side only (v16.rs:16328-16335; domain d = asset d/2, side d%2)", () => {
    // Domain 0 = asset 0 LONG side. A short leg on asset 0 is opposite → locked.
    const s = [claim(0, 10n)];
    expect(convertGate({ pnl: 10n, reservedPnl: 0n, sourceDomains: s, legs: [{ active: true, assetIndex: 0, side: 1 }] }).kind).toBe("locked");
    // A long leg on asset 0 (same side as the source) is not exposure.
    expect(convertGate({ pnl: 10n, reservedPnl: 0n, sourceDomains: s, legs: [{ active: true, assetIndex: 0, side: 0 }] }).kind).toBe("convertible");
    // Domain 3 = asset 1 SHORT side; a long on asset 1 is opposite.
    expect(convertGate({ pnl: 10n, reservedPnl: 0n, sourceDomains: [claim(3, 10n)], legs: [{ active: true, assetIndex: 1, side: 0 }] }).kind).toBe("locked");
  });
  it("sparse walk stops at the first default-tagged empty slot (v16.rs:10471-10476)", () => {
    // A claim AFTER the terminator is invisible to the engine.
    const s = [emptySlot(), claim(2, 10n)];
    expect(convertGate({ pnl: 10n, reservedPnl: 0n, sourceDomains: s, legs: flat }).kind).toBe("unbacked");
  });
});

describe("accountSourceRealizableSupport — v16.rs:11094-11215", () => {
  it("full credit, ample backing → support == face", () => {
    expect(accountSourceRealizableSupport([slot({ domain: 0, sourceClaimBoundNum: 500n * BOUND_SCALE })], 500n, all)).toBe(500n);
  });
  it("credit rate haircut floors (v16.rs:3281-3285)", () => {
    const half = { ...ample, creditRateNum: CREDIT_RATE_SCALE / 2n };
    expect(accountSourceRealizableSupport([slot({ domain: 0, sourceClaimBoundNum: 501n * BOUND_SCALE })], 501n, () => half)).toBe(250n);
  });
  it("bounded by the domain's available backing (v16.rs:2593-2609)", () => {
    const thin = { ...ample, freshReservedBackingNum: 300n * BOUND_SCALE, validLienedBackingNum: 100n * BOUND_SCALE, insuranceCreditReservedNum: 50n * BOUND_SCALE, validLienedInsuranceNum: 10n * BOUND_SCALE };
    // available = (300−100) + (50−10) = 240
    expect(accountSourceRealizableSupport([slot({ domain: 0, sourceClaimBoundNum: 1_000n * BOUND_SCALE })], 1_000n, () => thin)).toBe(240n);
  });
  it("claim beyond the face is clipped by `remaining` (the released face)", () => {
    expect(accountSourceRealizableSupport([slot({ domain: 0, sourceClaimBoundNum: 900n * BOUND_SCALE })], 100n, all)).toBe(100n);
  });
  it("lien support: counterparty share needs a Fresh, unexpired bucket; insurance share survives", () => {
    const lien = slot({ domain: 1, sourceClaimBoundNum: 100n * BOUND_SCALE, sourceClaimLienedNum: 100n * BOUND_SCALE, sourceLienEffectiveReserved: 100n, sourceLienCounterpartyBackingNum: 70n * BOUND_SCALE, sourceLienInsuranceBackingNum: 30n * BOUND_SCALE });
    expect(accountSourceRealizableSupport([lien], 100n, all)).toBe(100n);
    expect(accountSourceRealizableSupport([lien], 100n, () => ({ ...ample, counterpartyBucketFresh: false }))).toBe(30n);
  });
  it("locked > bound is InvalidLeg", () => {
    expect(() => accountSourceRealizableSupport([slot({ domain: 0, sourceClaimBoundNum: 1n, sourceClaimImpairedNum: 2n })], 5n, all)).toThrow("InvalidLeg");
  });
});

describe("simulateConvertMath — handler cap rule (v16_program.rs:19972-19975)", () => {
  const pf = { pnl: 384_788n, reservedPnl: 0n, sourceDomains: [slot({ domain: 0, sourceClaimBoundNum: 384_788n * BOUND_SCALE })], legs: flat };
  it("DEVNET HbzHDZP4 (SI): cap = pnl converts 384788 (sim: post capital +384788, pnl 0)", () => {
    expect(simulateConvertMath(pf, 384_788n, all)).toEqual({ ok: true, converted: 384_788n });
  });
  it("DEVNET: cap = pnl − 1 and cap = 1 are refused LockActive(21) — amount is a ceiling, not a request", () => {
    expect(simulateConvertMath(pf, 384_787n, all)).toEqual({ ok: false, code: WRAPPER_ERR.EngineLockActive });
    expect(simulateConvertMath(pf, 1n, all)).toEqual({ ok: false, code: WRAPPER_ERR.EngineLockActive });
  });
  it("cap = 0 is InvalidInstruction (:19949-19951); nothing released is LockActive", () => {
    expect(simulateConvertMath(pf, 0n, all)).toEqual({ ok: false, code: WRAPPER_ERR.InvalidInstruction });
    expect(simulateConvertMath({ ...pf, pnl: 0n }, 10n, all)).toEqual({ ok: false, code: WRAPPER_ERR.EngineLockActive });
  });
  it("the cap we sign (whole positive pnl) always admits the engine's conversion", () => {
    for (const reserved of [0n, 1n, 100_000n, 384_787n]) {
      const p = { ...pf, reservedPnl: reserved };
      const r = simulateConvertMath(p, convertCap(p.pnl), all);
      expect(r).toEqual({ ok: true, converted: 384_788n - reserved });
    }
  });
});

describe("planWithdraw — withdraw is capital-only (v16.rs:20435-20436)", () => {
  it("within capital: no convert", () => {
    expect(planWithdraw({ capital: 100n, convertible: 50n, amount: 100n })).toEqual({ needsConvert: false, fits: true });
  });
  it("above capital: convert first; fits up to capital + convertible", () => {
    expect(planWithdraw({ capital: 100n, convertible: 50n, amount: 150n })).toEqual({ needsConvert: true, fits: true });
    expect(planWithdraw({ capital: 100n, convertible: 50n, amount: 151n })).toEqual({ needsConvert: true, fits: false });
  });
  it("NEGATIVE CONTROL: nothing convertible → withdraw-all of capital+pnl does not fit (the pre-fix state)", () => {
    expect(planWithdraw({ capital: 49_975_111n, convertible: 0n, amount: 49_975_111n + 222_882n })).toEqual({ needsConvert: false, fits: false });
  });
});

describe("buildConvertReleasedPnlIx — handler accounts + wire (bd4fe5f8 :7251-7255, :31815-31825)", () => {
  it("is [owner signer RO, market W, portfolio W] + 33-byte payload", () => {
    const programId = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
    const owner = new PublicKey("3pae8qvc8wimpETqPkxYTYMciUiRNJ5Mpu8gGvBWqLxZ");
    const market = new PublicKey("8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx");
    const portfolio = new PublicKey("4yjoGo9NWMv8XCfV2CZgaP6RyjwxxV6XbvMzmR7Z8b3i");
    const ix = buildConvertReleasedPnlIx({ programId, owner, market, portfolio, portfolioId: 6n, positionEpoch: 2n, cap: 222_882n });
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [owner.toBase58(), true, false],
      [market.toBase58(), false, true],
      [portfolio.toBase58(), false, true],
    ]);
    const d = Buffer.from(ix.data);
    expect(d.length).toBe(33);
    expect(d[0]).toBe(28);
    expect(d.readBigUInt64LE(1)).toBe(6n);
    expect(d.readBigUInt64LE(9)).toBe(2n);
    expect(d.readBigUInt64LE(17)).toBe(222_882n);
    expect(d.readBigUInt64LE(25)).toBe(0n);
  });
});

describe("quoteConvertible — DEVNET fresh winner 4yjoGo9N (opened + closed short on SI)", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/4yjoGo9N.convert-winner.portfolio.json"), "utf8"));
  const pre = new Uint8Array(Buffer.from(fx.pre, "base64"));
  const post = new Uint8Array(Buffer.from(fx.postCrankConvert, "base64"));
  const programId = new PublicKey(fx.programId);
  const market = new PublicKey(fx.market);
  const portfolio = new PublicKey(fx.portfolio);
  const owner = new PublicKey(fx.owner);
  const params = { programId, owner, market, portfolio, portfolioData: pre };
  const custom = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });
  const tags = (ixs: TransactionInstruction[]) => ixs.map((i) => i.data[0]);

  it("fixture is a flat winner: capital 49975111, pnl 222882 → post capital 50197993", () => {
    const a = parsePortfolioV17(pre);
    const b = parsePortfolioV17(post);
    expect([a.capital, a.pnl, a.legs.some((l) => l.active)]).toEqual([49_975_111n, 222_882n, false]);
    expect([b.capital, b.pnl]).toEqual([50_197_993n, 0n]);
  });

  it("stale certificate (Stale 19, measured right after the close) → recertify crank + tag 28", () => {
    const seen: number[][] = [];
    const deps: QuoteDeps = {
      async simulate(ixs) {
        seen.push(tags(ixs));
        return ixs.length === 1 ? { err: custom(0, WRAPPER_ERR.EngineStale), postData: null, rpcFailed: false } : { err: null, postData: post, rpcFailed: false };
      },
    };
    return quoteConvertible(params, deps).then((q) => {
      expect(seen).toEqual([[28], [5, 28]]);
      expect(q.status).toBe("ready");
      if (q.status !== "ready") return;
      expect(q.postCapital).toBe(50_197_993n);
      expect(q.convertible).toBe(222_882n);
      expect(tags(q.prefix)).toEqual([5, 28]);
      expect(Buffer.from(q.prefix[1].data).readBigUInt64LE(17)).toBe(222_882n); // cap = whole pnl
    });
  });

  it("current certificate → tag 28 alone", async () => {
    const q = await quoteConvertible(params, { async simulate() { return { err: null, postData: post, rpcFailed: false }; } });
    expect(q.status === "ready" && tags(q.prefix)).toEqual([28]);
  });

  it("LockActive (not backed yet) → settling with one calm line; no crank retry", async () => {
    let calls = 0;
    const q = await quoteConvertible(params, { async simulate() { calls++; return { err: custom(0, WRAPPER_ERR.EngineLockActive), postData: null, rpcFailed: false }; } });
    expect(calls).toBe(1);
    expect(q).toEqual({ status: "settling", released: 222_882n, code: WRAPPER_ERR.EngineLockActive, reason: "backing" });
    expect(settlingProfitMessage(WRAPPER_ERR.EngineLockActive)).toMatch(/^Your profit becomes withdrawable once/);
  });

  it("a code not raised by one of our wrapper instructions is not attributed to the wrapper", async () => {
    const q = await quoteConvertible(params, { async simulate() { return { err: custom(-1, WRAPPER_ERR.EngineLockActive), postData: null, rpcFailed: false }; } });
    expect(q).toEqual({ status: "settling", released: 222_882n, code: null, reason: "unknown" });
  });

  it("tag 28 simulating to LockActive reads reason=backing; a stale certificate reads reason=stale", async () => {
    const lock = await quoteConvertible(params, { async simulate() { return { err: custom(0, WRAPPER_ERR.EngineLockActive), postData: null, rpcFailed: false }; } });
    expect(lock.status === "settling" && lock.reason).toBe("backing");
    const stale = await quoteConvertible(params, { async simulate() { return { err: custom(0, WRAPPER_ERR.EngineStale), postData: null, rpcFailed: false }; } });
    expect(stale.status === "settling" && stale.reason).toBe("stale");
    const rpc = await quoteConvertible(params, { async simulate() { return { err: null, postData: null, rpcFailed: true }; } });
    expect(rpc.status === "settling" && rpc.reason).toBe("unknown");
  });

  describe("convertPrefixForWithdraw (useWithdraw's decision)", () => {
    const ready: QuoteDeps = { async simulate() { return { err: null, postData: post, rpcFailed: false }; } };
    const never: QuoteDeps = { async simulate() { throw new Error("must not simulate"); } };
    it("amount within capital → no prefix, no RPC", async () => {
      expect(await convertPrefixForWithdraw({ ...params, amount: 49_975_111n }, never)).toEqual([]);
    });
    it("withdraw-all (capital + pnl) → [tag 28] in front", async () => {
      const ixs = await convertPrefixForWithdraw({ ...params, amount: 50_197_993n }, ready);
      expect(tags(ixs)).toEqual([28]);
    });
    it("one atom over capital + convertible → refused before signing", async () => {
      await expect(convertPrefixForWithdraw({ ...params, amount: 50_197_994n }, ready)).rejects.toThrow(WITHDRAW_EXCEEDS_BALANCE_MESSAGE);
    });
    it("profit not backed yet → one calm line, not a revert", async () => {
      const lock: QuoteDeps = { async simulate() { return { err: custom(0, WRAPPER_ERR.EngineLockActive), postData: null, rpcFailed: false }; } };
      const p = convertPrefixForWithdraw({ ...params, amount: 50_197_993n }, lock);
      await expect(p).rejects.toBeInstanceOf(WithdrawRefusal);
      await expect(p).rejects.toThrow(settlingProfitMessage(WRAPPER_ERR.EngineLockActive));
    });
    it("no profit and amount over capital → exceeds-balance refusal, no RPC", async () => {
      await expect(convertPrefixForWithdraw({ ...params, portfolioData: post, amount: 50_197_994n }, never)).rejects.toThrow(WITHDRAW_EXCEEDS_BALANCE_MESSAGE);
    });
  });

  it("no profit → none (no RPC)", async () => {
    const deps: QuoteDeps = { async simulate() { throw new Error("must not simulate"); } };
    const noProfit = new Uint8Array(post); // post state has pnl 0
    expect(await quoteConvertible({ ...params, portfolioData: noProfit }, deps)).toEqual({ status: "none" });
  });
});

// ── v2.2 QA W-1/W-2: "Held: waiting on backing" is decided by the chain read, then the timer ──
import { HELD_AFTER_MS, HELD_PROFIT_TITLE, heldProfitMessage, isProfitHeld } from "@/lib/convert-released-pnl";

describe("held profit status (W-1/W-2)", () => {
  it("only a chain-confirmed 'backing' (after the wait) or 'unbacked' (at once) is held; stale / locked / unknown never are", () => {
    const t0 = 1_000_000;
    expect(isProfitHeld({ reason: "backing" }, t0, t0 + HELD_AFTER_MS - 1)).toBe(false);
    expect(isProfitHeld({ reason: "backing" }, t0, t0 + HELD_AFTER_MS)).toBe(true);
    expect(isProfitHeld({ reason: "backing" }, null, t0 + 10 * HELD_AFTER_MS)).toBe(false);
    expect(isProfitHeld({ reason: "unbacked" }, null, t0)).toBe(true);
    for (const reason of ["stale", "locked", "unknown"] as const) expect(isProfitHeld({ reason }, t0, t0 + 10 * HELD_AFTER_MS)).toBe(false);
  });

  it("the held line names the amount and no longer promises automatic settlement", () => {
    const m = heldProfitMessage("0.515 USDC");
    expect(m.startsWith(HELD_PROFIT_TITLE)).toBe(true);
    expect(m).toContain("0.515 USDC");
    expect(m).not.toMatch(/automatically; /);
    expect(settlingProfitMessage(WRAPPER_ERR.EngineLockActive)).not.toMatch(/happens automatically/);
  });
});
