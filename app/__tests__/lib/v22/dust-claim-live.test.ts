/**
 * QA 12:38 (Low): 0.196 USDC stuck in QA's swordcat account. Fed with the LIVE portfolio bytes (FnY2i6UF…, slot 510974481) and the program's
 * measured answers (simulateTransaction, sigVerify:false, 2026-10-14T11:39:54Z, slot 510974696):
 *   tag 28 alone                    -> Custom 19 (certificate behind)
 *   crank + tag 28                  -> OK, capital 196157, pnl 0
 *   withdraw 196157 without convert -> 21
 *   crank + tag 28 + withdraw 196157-> OK
 *   close account as is (pnl 196157)-> 21
 */
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fx from "../../fixtures/v22-swordcat-dust-portfolio-510974481.json";
import { convertGate, planConvertWithdraw, quoteConvertible, type QuoteDeps } from "@/lib/convert-released-pnl";
import { assessPortfolioBytes } from "@/lib/close-trading-account";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parsePortfolio } from "@/lib/v22/layout";
import { liftV22Portfolio } from "../../helpers/portfolio-disc20";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const OWNER = new PublicKey("6Rz2i9cRAQ2JRZ9pZAuPidYQAYhrJSWbbWaJAVvknAVq");
const MARKET = new PublicKey("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF");
const PF = new PublicKey("FnY2i6UFCwHQYbS8rcA6QzjcgUxwZzYXjHhjDeLM1b68");
const BYTES = liftV22Portfolio(new Uint8Array(Buffer.from(fx.portfolio, "base64"))); // recorded pre-#299: lifted to disc 20

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

/** The chain as measured: tag 28 alone is stale (19 at the convert, index 0); with the recertify crank in front it converts everything. */
const chainDeps = (calls: number[][] = []): QuoteDeps => ({
  async simulate(ixs) {
    calls.push(ixs.map((i) => i.data[0] as number));
    if (ixs.length === 1) return { err: { InstructionError: [0, { Custom: 19 }] }, postData: null, rpcFailed: false };
    const post = BYTES.slice();
    // post state: capital 196157, pnl 0 (what the program returned): patch via the parsed layout offsets is not needed, the quote reads
    // capital from the bytes, so give it the same account with capital moved
    return { err: null, postData: withCapital(post, 196_157n), rpcFailed: false };
  },
});

function withCapital(bytes: Uint8Array, capital: bigint): Uint8Array {
  // locate the capital field by value-search of the parsed layout: capital is 0 now; find the u128 slot right before pnl (196157) in the account
  const pnlNeedle = new Uint8Array(16); new DataView(pnlNeedle.buffer).setBigUint64(0, 196_157n, true);
  for (let i = 16; i < 400; i++) {
    let hit = true;
    for (let k = 0; k < 16; k++) if (bytes[i + k] !== pnlNeedle[k]) { hit = false; break; }
    if (hit) { new DataView(bytes.buffer).setBigUint64(i - 16, capital, true); new DataView(bytes.buffer).setBigUint64(i, 0n, true); return bytes; }
  }
  throw new Error("pnl field not found");
}

describe("live account: what it is", () => {
  it("flat, capital 0, pnl 196,157, nothing reserved", () => {
    const pf = parsePortfolio(BYTES);
    expect(pf.capital).toBe(0n);
    expect(pf.pnl).toBe(196_157n);
    expect(pf.reservedPnl).toBe(0n);
    expect(pf.legs.some((l) => l.active)).toBe(false);
    expect(convertGate(pf)).toEqual({ kind: "convertible", released: 196_157n });
  });
  it("Close account is NOT possible yet (program: 21 with pnl on the account) - the profit has to be withdrawn first", () => {
    expect(assessPortfolioBytes(BYTES, OWNER)).toEqual({ closable: false, reason: "unsettled" });
  });
});

describe("the claim plan the app signs", () => {
  it("quote: tag 28 alone is stale (19), so the recertify crank goes in front and the profit is READY", async () => {
    const calls: number[][] = [];
    const q = await quoteConvertible({ programId: WRAPPER, owner: OWNER, market: MARKET, portfolio: PF, portfolioData: BYTES }, chainDeps(calls));
    expect(q.status).toBe("ready");
    if (q.status === "ready") {
      expect(q.postCapital).toBe(196_157n);
      expect(q.prefix).toHaveLength(2); // [crank, tag 28]
    }
    expect(calls).toHaveLength(2);
  });
  it("one-click withdraw all: [crank, tag 28] then withdraw of the whole 196,157 (program: OK)", async () => {
    const plan = await planConvertWithdraw({ programId: WRAPPER, owner: OWNER, market: MARKET, portfolio: PF, portfolioData: BYTES, amount: 196_157n }, chainDeps());
    expect(plan.amount).toBe(196_157n);
    expect(plan.prefix).toHaveLength(2);
    expect(plan.notice).toBeNull();
  });
  it("NEGATIVE CONTROL: without the prefix the withdraw alone would be refused (21): a plan with no prefix is never produced for this account", async () => {
    const plan = await planConvertWithdraw({ programId: WRAPPER, owner: OWNER, market: MARKET, portfolio: PF, portfolioData: BYTES, amount: 196_157n }, chainDeps());
    expect(plan.prefix.length).toBeGreaterThan(0);
  });
});
