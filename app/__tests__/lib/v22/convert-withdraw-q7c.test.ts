// @vitest-environment node
/** v2.2 QA Q-7c / W-1: convert + withdraw on real v2.2 bytes (QA's flat CHILLHOUSE winner: capital 196,253,517, pnl 96,212). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../../fixtures/v22-flat-winner-portfolio-2026-10-11.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parsePortfolio } from "@/lib/v22/layout";
import { buildRecertifyCrankIx, CONVERT_RELEASED_PNL_TAG, planConvertWithdraw, PROFIT_NOT_MOVABLE_MESSAGE, WithdrawRefusal, type QuoteDeps } from "@/lib/convert-released-pnl";
import { defaultCrankObservations } from "@/lib/v18-wire";
import { encodePermissionlessCrank } from "@percolatorct/sdk";
import { liftV22Portfolio } from "../../helpers/portfolio-disc20";

const data = liftV22Portfolio(Uint8Array.from(Buffer.from(fixture.b64, "base64"))); // recorded pre-#299: lifted to disc 20 / 10,607 B
const program = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const base = { programId: program, owner: new PublicKey(fixture.owner), market: new PublicKey(fixture.market), portfolio: new PublicKey(fixture.portfolio), portfolioData: data };

/** A post-state with `capital` set (same bytes otherwise): what the simulation hands back. */
function withCapital(capital: bigint): Uint8Array {
  const pf = parsePortfolio(data);
  const out = Uint8Array.from(data);
  const dv = new DataView(out.buffer);
  // locate the capital field by value (u128 LE) in the real bytes
  const lo = pf.capital & ((1n << 64n) - 1n);
  for (let o = 0; o + 16 <= out.length; o++) {
    if (dv.getBigUint64(o, true) === lo && dv.getBigUint64(o + 8, true) === pf.capital >> 64n) {
      dv.setBigUint64(o, capital & ((1n << 64n) - 1n), true);
      dv.setBigUint64(o + 8, capital >> 64n, true);
      break;
    }
  }
  return out;
}
const deps = (post: bigint): QuoteDeps & { simulate: ReturnType<typeof vi.fn> } => ({ simulate: vi.fn(async () => ({ err: null, postData: withCapital(post), rpcFailed: false })) });

describe("Q-7c / W-1: planConvertWithdraw", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));
  const pf = () => parsePortfolio(data);

  it("fixture sanity: a flat winner with capital and released profit; the helper really rewrites capital", () => {
    expect(pf().legs.some((l) => l.active)).toBe(false);
    expect(pf().capital).toBe(196_253_517n);
    expect(pf().pnl).toBe(96_212n);
    expect(parsePortfolio(withCapital(5n)).capital).toBe(5n);
  });

  it("withdraw-all asks for capital + the pnl FACE; the plan withdraws the simulated post-conversion capital (1 atom short), same tx", async () => {
    const face = pf().capital + pf().pnl;
    const post = face - 1n; // tag 28 floors per source domain
    const plan = await planConvertWithdraw({ ...base, amount: face }, deps(post));
    expect(plan.amount).toBe(post);
    expect(plan.notice).toBeNull();
    expect(plan.prefix[plan.prefix.length - 1].data[0]).toBe(CONVERT_RELEASED_PNL_TAG);
  });

  it("W-1: a gain short of the profit by more than 0.1% is NOT converted: only the existing capital is withdrawn, with the calm line", async () => {
    const face = pf().capital + pf().pnl;
    const haircut = pf().capital + (pf().pnl * 852n) / 1000n; // QA's -14.8%
    const plan = await planConvertWithdraw({ ...base, amount: face }, deps(haircut));
    expect(plan.prefix).toEqual([]);
    expect(plan.amount).toBe(pf().capital);
    expect(plan.notice).toBe(PROFIT_NOT_MOVABLE_MESSAGE);
    // exactly at the tolerance (0.1%) it still converts
    const edge = pf().capital + pf().pnl - (pf().pnl * 10n) / 10_000n;
    expect((await planConvertWithdraw({ ...base, amount: face }, deps(edge))).prefix.length).toBeGreaterThan(0);
  });

  it("within capital: no simulation, no prefix; beyond capital + profit: refused as before", async () => {
    const d = deps(0n);
    expect(await planConvertWithdraw({ ...base, amount: 1_000_000n }, d)).toEqual({ prefix: [], amount: 1_000_000n, notice: null });
    expect(d.simulate).not.toHaveBeenCalled();
    await expect(planConvertWithdraw({ ...base, amount: pf().capital + pf().pnl + 1n }, deps(pf().capital + pf().pnl))).rejects.toBeInstanceOf(WithdrawRefusal);
  });

  it("the recertify crank observes EVERY asset on a multi-asset market; one slot is byte-identical to before", () => {
    const one = buildRecertifyCrankIx(program, base.owner, base.market, base.portfolio);
    expect(Buffer.from(one.data).equals(Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) })))).toBe(true);
    const five = buildRecertifyCrankIx(program, base.owner, base.market, base.portfolio, 5);
    expect(Buffer.from(five.data).equals(Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: [0, 1, 2, 3, 4].map((assetIndex) => ({ assetIndex, oracleAccounts: 0 })) })))).toBe(true);
  });
});
