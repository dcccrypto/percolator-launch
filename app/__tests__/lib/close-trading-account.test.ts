// @vitest-environment node
/**
 * #3426: `assessPortfolioBytes` / `isPortfolioClosable` mirror the engine's `is_empty_for_dematerialization`
 * (percolator v16.rs:6302) + the wrapper's ClosePortfolio authority rule (v16_program.rs:19777). Real v2.1 and
 * v2.2 portfolio bytes, edited one field at a time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parsePortfolio } from "@/lib/v22/layout";
import { assessPortfolioBytes, isPortfolioClosable, lamportsToSolText, rawStateRefusal, type Closability } from "@/lib/close-trading-account";
import { OFF, base, closeProgressOff, emptied, layoutFor, lockOff, receiptOff, setU128, walletOf, type Fx } from "../helpers/close-account-fixtures";

const modes: Array<{ name: string; fx: Fx; flag: boolean }> = [
  { name: "v2.1 bytes, flag off", fx: "v21", flag: false },
  { name: "v2.1 bytes, flag on", fx: "v21", flag: true },
  { name: "v2.2 bytes, flag on", fx: "v22", flag: true },
];

const refused = (r: Closability) => (r.closable ? null : r.reason);

describe.each(modes)("closable predicate: $name", ({ fx, flag }) => {
  afterEach(() => __setDevnetV22ForTest(null));
  const wallet = (d: Buffer) => walletOf(d);
  const check = (d: Buffer, w: PublicKey = wallet(d)) => {
    __setDevnetV22ForTest(flag);
    return assessPortfolioBytes(d, w);
  };

  it("the empty own account is closable", () => {
    expect(check(emptied(fx))).toEqual({ closable: true });
  });

  it("the unedited fixture is not (it holds capital / pnl / a leg)", () => {
    expect(check(base(fx)).closable).toBe(false);
  });

  it("capital, fee credits or a cancel-deposit escrow -> has-balance (no dust allowance)", () => {
    for (const off of [OFF.capital, OFF.fee, OFF.escrow]) {
      expect(refused(check(setU128(emptied(fx), off, 1n)))).toBe("has-balance");
    }
  });

  it("an active leg or a set bitmap -> open-position", () => {
    const P = layoutFor(fx);
    const leg = emptied(fx);
    leg[P.legsOff + P.leg.active] = 1;
    expect(refused(check(leg))).toBe("open-position");
    const bm = emptied(fx);
    bm[OFF.bitmap] = 1;
    expect(refused(check(bm))).toBe("open-position");
  });

  it("pnl or reserved pnl -> unsettled", () => {
    expect(refused(check(setU128(emptied(fx), OFF.pnl, 5n)))).toBe("unsettled");
    expect(refused(check(setU128(emptied(fx), OFF.reserved, 5n)))).toBe("unsettled");
  });

  it("an occupied source domain -> unsettled", () => {
    const P = layoutFor(fx);
    const d = emptied(fx);
    d[P.sourceDomainsOff + 12] = 1; // source_claim_bound_num, low byte
    expect(refused(check(d))).toBe("unsettled");
  });

  it("each of the four lock / stale flags -> unsettled", () => {
    for (let i = 0; i < 4; i++) {
      const d = emptied(fx);
      d[lockOff(fx) + i] = 1;
      expect(refused(check(d))).toBe("unsettled");
    }
  });

  it("a close in progress -> unsettled; an inert canceled or finalized-inert ledger is allowed (engine exemptions)", () => {
    const cp = closeProgressOff(fx);
    const active = emptied(fx);
    active[cp] = 1; // active, not finalized
    expect(refused(check(active))).toBe("unsettled");
    const withProgress = emptied(fx);
    withProgress[cp + 2] = 1; // canceled
    withProgress.writeBigUInt64LE(7n, cp + 3); // close_id
    setU128(withProgress, cp + 56, 1n); // support_consumed: irreversible progress
    expect(refused(check(withProgress))).toBe("unsettled");
    const inertCanceled = emptied(fx);
    inertCanceled[cp + 2] = 1;
    inertCanceled.writeBigUInt64LE(7n, cp + 3);
    setU128(inertCanceled, cp + 24, 9n); // gross_loss_at_close_start
    setU128(inertCanceled, cp + 168, 9n); // residual_remaining == gross
    expect(check(inertCanceled)).toEqual({ closable: true });
    const finalizedInert = emptied(fx);
    finalizedInert[cp] = 1;
    finalizedInert[cp + 1] = 1;
    finalizedInert.writeBigUInt64LE(7n, cp + 3);
    expect(check(finalizedInert)).toEqual({ closable: true });
  });

  it("a resolved payout receipt that is present and not finalized -> unsettled; finalized is allowed", () => {
    const r = receiptOff(fx);
    const open = emptied(fx);
    open[r + 64] = 1;
    expect(refused(check(open))).toBe("unsettled");
    const done = emptied(fx);
    done[r + 64] = 1;
    done[r + 65] = 1;
    expect(check(done)).toEqual({ closable: true });
  });

  it("the market's LP (matcher enabled) -> lp", () => {
    const d = emptied(fx);
    d[layoutFor(fx).matcherConfigOff + 96] |= 1;
    expect(refused(check(d))).toBe("lp");
  });

  it("another wallet's account -> not-yours", () => {
    expect(refused(check(emptied(fx), Keypair.generate().publicKey))).toBe("not-yours");
  });

  it("an account whose owner moved to an NFT escrow (provenance still this wallet) -> wrapped", () => {
    const d = emptied(fx);
    Keypair.generate().publicKey.toBuffer().copy(d, 116); // mutable owner
    __setDevnetV22ForTest(flag);
    const provenance = new PublicKey(d.subarray(80, 112));
    expect(refused(assessPortfolioBytes(d, provenance))).toBe("wrapped");
  });

  it("garbage bytes -> unreadable, never a throw", () => {
    expect(refused(check(Buffer.alloc(40)))).toBe("unreadable");
  });

  it("rawStateRefusal and the parsed predicate agree with the byte check on the empty account", () => {
    __setDevnetV22ForTest(flag);
    const d = emptied(fx);
    expect(rawStateRefusal(d)).toBeNull();
    expect(isPortfolioClosable(parsePortfolio(d), walletOf(d))).toEqual({ closable: true });
  });
});

describe("lamportsToSolText", () => {
  it("is derived from the lamports it is given", () => {
    expect(lamportsToSolText(49_230_280)).toBe("0.049");
    expect(lamportsToSolText(55_000_000)).toBe("0.055");
    expect(lamportsToSolText(5_000_000)).toBe("0.0050");
  });
});
