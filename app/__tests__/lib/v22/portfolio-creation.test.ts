// @vitest-environment node
/**
 * Every flow that creates a portfolio account creates it at EXACTLY the active layout's PORTFOLIO_ACCOUNT_LEN
 * (10,603 B flag on / 9,563 B flag off). v2.2 cannot realloc past 10,240 B, so any other length fails on chain.
 * Pure builders are exercised directly; the hooks / route (which need a wallet + RPC) are guarded at the source
 * level: none may name a hard-coded length or the installed constant any more.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, SystemInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LAYOUT_V22, LAYOUT_V21 } from "@/lib/v22/sdk";
import { createPortfolioAccountIx, portfolioAccountLen } from "@/lib/v22/layout";
import { buildFirstTradeInitIxs } from "@/lib/first-trade";
import { launchCreatePins } from "@/lib/launch-single-tx/shape";
import { computeCreateMarketSolCost } from "@/components/create/CostEstimate";
import { buildP3BindIxs } from "@/lib/limits/p3-wizard";

afterEach(() => __setDevnetV22ForTest(null));

const k = () => Keypair.generate().publicKey;
const spaceOf = (ix: Parameters<typeof SystemInstruction.decodeCreateAccount>[0]): number => Number(SystemInstruction.decodeCreateAccount(ix).space);

const FLOWS: Array<[string, () => number]> = [
  ["createPortfolioAccountIx (shared helper)", () => spaceOf(createPortfolioAccountIx(k(), k(), 1, k()))],
  ["first trade [create, init, deposit, trade]", () => spaceOf(buildFirstTradeInitIxs({ programId: k(), owner: k(), market: k(), portfolio: k() }, 1)[0])],
  ["launch single-tx pin (vault LP portfolio)", () => launchCreatePins({ wrapper: "W", matcher: "M", tokenProgram: "T" }).vaultLpPortfolio.space],
];

describe.each([
  ["flag ON", true, LAYOUT_V22.portfolio.accountLen, 10603],
  ["flag OFF", false, LAYOUT_V21.portfolio.accountLen, 9563],
] as const)("%s", (_n, on, layoutLen, literal) => {
  it("the length is the layout's", () => {
    __setDevnetV22ForTest(on);
    expect(layoutLen).toBe(literal);
    expect(portfolioAccountLen()).toBe(literal);
  });
  it.each(FLOWS)("%s creates the portfolio at exactly the layout length", (_f, run) => {
    __setDevnetV22ForTest(on);
    expect(run()).toBe(literal);
  });
  it("fund-and-trade / LP / vault-LP bind: the P3 bind carries the exact length through createAccount", () => {
    __setDevnetV22ForTest(on);
    const prog = k(), lp = k();
    const ixs = buildP3BindIxs({
      market: { programId: prog, market: k(), registry: k(), vaultLpState: k(), lpPortfolio: lp, ledger: k(), siblingLedger: k() } as never,
      creator: k(), vaultLpPortfolio: lp, portfolioLen: portfolioAccountLen(), portfolioRentLamports: 1,
      matcherProgram: k(), matcherCtx: k(), matcherCtxRentLamports: 1, juniorFloorBps: 1000, juniorAtoms: 1n, creatorAta: k(), vaultToken: k(),
    } as never);
    expect(spaceOf(ixs[0])).toBe(literal);
  });
  it("the SOL estimate prices the portfolio at that length", () => {
    __setDevnetV22ForTest(on);
    const a = computeCreateMarketSolCost({ p3: false }).lpPortfolioMatcherRentSol;
    __setDevnetV22ForTest(!on);
    const b = computeCreateMarketSolCost({ p3: false }).lpPortfolioMatcherRentSol;
    expect(on ? a > b : a < b).toBe(true); // v2.2 portfolio is bigger, so costs more rent
  });
});

describe("NEGATIVE CONTROL: a hard-coded 9563 under flag ON is caught", () => {
  it("fails the exact-length assertion", () => {
    __setDevnetV22ForTest(true);
    const wrong = spaceOf(createPortfolioAccountIx(k(), k(), 1, k())) === 9563;
    expect(wrong).toBe(false);
    // and an instruction built at the old length is detected by the same assertion the table uses
    const old = LAYOUT_V21.portfolio.accountLen;
    expect(() => expect(old).toBe(portfolioAccountLen())).toThrow();
  });
});

describe("source guard: no flow names a portfolio length of its own", () => {
  const FILES = [
    "hooks/useDeposit.ts", "hooks/useInitUser.ts", "hooks/useFirstTrade.ts", "hooks/useCreateMarket.ts",
    "lib/first-trade.ts", "lib/launch-single-tx/shape.ts", "app/api/mobile/create-market/route.ts", "components/create/CostEstimate.tsx", "lib/lp-portfolio.ts",
  ];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const offends = (src: string) => /V17_PORTFOLIO_ACCOUNT_(LEN|SIZE)\b|\b(9563|10603|9347|10091)\b/.test(strip(src));
  it.each(FILES)("%s", (f) => {
    expect(offends(readFileSync(join(__dirname, "../../..", f), "utf8"))).toBe(false);
  });
  it("NEGATIVE CONTROL: the detector flags a hard-coded length", () => {
    expect(offends("const rent = await c.getMinimumBalanceForRentExemption(9563);")).toBe(true);
    expect(offends("space: V17_PORTFOLIO_ACCOUNT_LEN")).toBe(true);
    expect(offends("space: portfolioAccountLen()")).toBe(false);
  });
});
