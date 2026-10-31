// @vitest-environment node
/**
 * A-2 (v2.2 QA 2026-10-11): a flat winner's profit sits in `pnl` until tag 28 ConvertReleasedPnl moves it into
 * capital; on a flat account tag 28 needs a crank THROUGH the user's own portfolio in the same tx (bare 28 -> 19).
 * useWithdraw folds exactly that pair in front of a withdraw above capital (convertPrefixForWithdraw), and the
 * withdraw card shows capital + convertible profit as the balance. Pinned here on QA's REAL v2.2 flat winner
 * (10,603 B portfolio, pnl 96,212). Devnet: the app builder's [crank, 28, withdraw] simulates clean on it; the same
 * withdraw without the prefix is refused 21 (ledger v22-qa-issues.md A-2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import fixture from "../fixtures/v22-flat-winner-portfolio-2026-10-11.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parsePortfolio } from "@/lib/v22/layout";
import { convertGate, convertPrefixForWithdraw, WithdrawRefusal, type QuoteDeps } from "@/lib/convert-released-pnl";
import { liftV22Portfolio } from "../helpers/portfolio-disc20";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const data = () => liftV22Portfolio(new Uint8Array(Buffer.from(fixture.b64, "base64"))); // recorded pre-#299: lifted to disc 20
const base = () => ({ programId: WRAPPER, owner: new PublicKey(fixture.owner), market: new PublicKey(fixture.market), portfolio: new PublicKey(fixture.portfolio), portfolioData: data() });

/** The handler as oracle: bare 28 -> 19 (stale certificate on a flat account); [crank, 28] -> capital += pnl. */
function chain(): QuoteDeps & { calls: TransactionInstruction[][] } {
  const calls: TransactionInstruction[][] = [];
  return {
    calls,
    async simulate(ixs) {
      calls.push(ixs);
      if (ixs.length === 1) return { err: { InstructionError: [0, { Custom: 19 }] }, postData: null, rpcFailed: false };
      const post = data();
      const pf = parsePortfolio(post);
      // capital += 96,212 at the portfolio's capital offset: find it by value (u128 LE) in the bytes.
      const dv = new DataView(post.buffer, post.byteOffset, post.byteLength);
      for (let o = 0; o + 8 <= post.length; o++) if (dv.getBigUint64(o, true) === pf.capital) { dv.setBigUint64(o, pf.capital + pf.pnl, true); break; }
      return { err: null, postData: post, rpcFailed: false };
    },
  };
}

describe("A-2 withdraw auto-converts a flat winner's profit (real v2.2 bytes)", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));

  it("decodes the v2.2 portfolio: capital 196,253,517, pnl 96,212, flat, convertible", () => {
    const pf = parsePortfolio(data());
    expect(pf.capital).toBe(196_253_517n);
    expect(pf.pnl).toBe(96_212n);
    expect(pf.legs.some((l) => l.active)).toBe(false);
    expect(convertGate(pf).kind).toBe("convertible");
  });

  it("a withdraw above capital gets [crank through the user's own portfolio, tag 28] in front", async () => {
    const deps = chain();
    const prefix = await convertPrefixForWithdraw({ ...base(), amount: 196_253_517n + 96_212n }, deps);
    expect(prefix).toHaveLength(2);
    const [crank, convert] = prefix;
    expect(crank.data[0]).toBe(5); // PermissionlessCrank
    expect(crank.keys.map((k) => k.pubkey.toBase58())).toEqual([fixture.owner, fixture.market, fixture.portfolio]);
    expect(convert.data[0]).toBe(28); // ConvertReleasedPnl
    expect(convert.keys[2].pubkey.toBase58()).toBe(fixture.portfolio);
  });

  it("NEGATIVE CONTROLS: within capital => no prefix; above capital + profit => a calm refusal", async () => {
    expect(await convertPrefixForWithdraw({ ...base(), amount: 196_253_517n }, chain())).toEqual([]);
    await expect(convertPrefixForWithdraw({ ...base(), amount: 196_253_517n + 96_213n }, chain())).rejects.toBeInstanceOf(WithdrawRefusal);
  });
});
