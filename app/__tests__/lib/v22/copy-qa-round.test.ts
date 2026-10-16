/**
 * v2.2 copy QA round (2026-10-14, fix/v22-copy-qa): items 1, 3, 4, 5, 6, 7, 8, 9, 12 at the copy / resolver level.
 * (The withdraw 19 path, the portfolio cards and the multi-asset notice have their own files.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError } from "@/lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { V22_ERROR_CODE_MAP, V22_STAKE_ERROR_CODE_MAP } from "@/lib/v22/error-copy";
import { V22_COUNTERPARTY_CAP_COPY, V22_CUSTOM9_OFF_TICKET, positionCapCopy, positionCapBlocksOpen } from "@/lib/v22/trade-refusal-9-copy";
import { classifyV22Custom9 } from "@/lib/v22/trade-refusal-9";
import { V22_COPY } from "@/lib/v22/copy";
import { LAYOUT_V21, LAYOUT_V22 } from "@/lib/v22/sdk";
import { PERCOLATOR_ERRORS_V22 } from "@/lib/v22/sdk/errors-v22";
import { isMultiAssetMarket, readMaxPortfolioAssets } from "@/lib/v22/market-cap";
import { ADMIN_BURN_COPY } from "@/lib/admin-burn-copy";
import { STAKE_COPY } from "@/lib/stake-copy";
import { PAYOUT_RESERVE_COPY } from "@/lib/wizard-copy";
import { feeRaiseCopy, recordFeeRaise, takeFeeRaise } from "@/lib/v22/fee-raise-note";
import { growthMaxLeverageForOrder, growthMarketView } from "@/lib/v21/growth-market";
import { ceilingImrBps, dynImrBps, leverageX100ForImrBps } from "@/lib/v21/sdk";
import { ENGINE, LP, marketRaw } from "../v21/fixtures";
import { syntheticMarket } from "./_stamp";

const ids = resolveDevnetProgramIds();
const fail = (code: number, programId: string | null = ids.wrapper): Error & { programId: string | null } => {
  const e = new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`) as Error & { programId: string | null };
  e.programId = programId;
  return e;
};
const raw = (code: number, programId: string = ids.wrapper): string =>
  `Transaction simulation failed: Error processing Instruction 2: custom program error: 0x${code.toString(16)}\nProgram ${programId} failed: custom program error: 0x${code.toString(16)}`;

beforeEach(() => {
  __setDevnetV21ForTest(true);
  __setDevnetV22ForTest(true);
});
afterEach(() => {
  __setDevnetV21ForTest(null);
  __setDevnetV22ForTest(null);
});

describe("items 1 + 4: codes 126 / 127 copy, and the cap comes from the market", () => {
  it("126 says close a position or try later, with the market's own number, via ONE function", () => {
    const m = resolveUserMessage(fail(126), { surface: "trade", maxPositions: 2 });
    expect(m.body).toBe(positionCapCopy(2));
    expect(m.body).toContain("maximum of 2 positions");
    expect(m.body).toMatch(/Close one, or try again later/);
    expect(m.body).not.toMatch(/another asset/i);
    expect(m.body).not.toMatch(/\b4\b/);
  });
  it("126 without a known cap drops the number instead of guessing 4; a cap of 1 is singular", () => {
    expect(resolveUserMessage(fail(126), { surface: "trade" }).body).toBe(positionCapCopy());
    expect(positionCapCopy()).not.toMatch(/\d/);
    expect(positionCapCopy(null)).toBe(positionCapCopy());
    expect(positionCapCopy(0)).toBe(positionCapCopy());
    expect(positionCapCopy(1)).toContain("maximum of 1 position on");
    expect(positionCapCopy(1)).not.toContain("positions");
  });
  it("the plain-string table (cap-less) and the structured resolver share the same function", () => {
    expect(V22_ERROR_CODE_MAP[126]).toBe(positionCapCopy());
    expect(humanizeError(raw(126))).toBe(positionCapCopy());
  });
  it("127 says the other side is at its limit and to try later, never 'another asset'", () => {
    const m = resolveUserMessage(fail(127), { surface: "trade" });
    expect(m.body).toBe(V22_COUNTERPARTY_CAP_COPY);
    expect(m.body).toMatch(/other side/);
    expect(m.body).toMatch(/Try again later/);
    expect(m.body).not.toMatch(/another asset/i);
    expect(V22_ERROR_CODE_MAP[127]).not.toMatch(/another asset/i);
  });
  it("the classifier uses the market's cap: 2 held on a cap-2 market blocks a new asset, but not on the default cap", () => {
    expect(positionCapBlocksOpen([0, 1], 2, 2)).toBe(true);
    expect(positionCapBlocksOpen([0, 1], 2)).toBe(false); // default = program cap 4
    expect(positionCapBlocksOpen([0, 1], 1, 2)).toBe(false); // adding to a held asset
    const facts = { heldAssets: [0, 1], assetIndex: 2, quotePriceE6: null, takerBuys: true };
    expect(classifyV22Custom9({ ...facts, maxPositions: 2 })).toBe("position-cap");
    expect(classifyV22Custom9(facts)).toBe("undetermined");
  });
  it("multi-asset is read from the market's own config (max_portfolio_assets), not a list", () => {
    for (const L of [LAYOUT_V21, LAYOUT_V22]) {
      const mk = (n: number) => {
        const d = syntheticMarket(L, 1);
        new DataView(d.buffer).setUint16(L.marketGroupOff + L.group.config, n, true);
        return d;
      };
      expect(readMaxPortfolioAssets(mk(4))).toBe(4);
      expect(isMultiAssetMarket(mk(4))).toBe(true);
      expect(isMultiAssetMarket(mk(2))).toBe(true);
      expect(isMultiAssetMarket(mk(1))).toBe(false); // negative control: single-asset
      expect(isMultiAssetMarket(mk(0))).toBe(false);
    }
    expect(isMultiAssetMarket(null)).toBe(false);
    expect(isMultiAssetMarket(new Uint8Array(10))).toBe(false);
  });
});

describe("item 3: what burning the admin key really renounces", () => {
  const all = Object.values(ADMIN_BURN_COPY).join("\n");
  it("no longer claims the false things", () => {
    expect(all).not.toMatch(/no one can/i);
    expect(all).not.toMatch(/touch (its|this market's) funds/i);
    expect(all).not.toMatch(/pause/i);
    expect(all).not.toMatch(/runs (purely )?on its own code/i);
    expect(all).not.toMatch(/change (this market's )?config/i);
  });
  it("states exactly what it clears and what stays", () => {
    for (const s of [ADMIN_BURN_COPY.landing, ADMIN_BURN_COPY.burned]) {
      expect(s).toMatch(/creator fees/);
      expect(s).toMatch(/price-feed, insurance and backing keys/);
      expect(s).toMatch(/upgrade key/);
      expect(s).toMatch(/market authority/);
    }
    expect(ADMIN_BURN_COPY.active).toMatch(/claim creator fees/);
  });
});

describe("items 5 + 9: plain messages for 28, 29, 93, stake 29, a bare 9 and 104", () => {
  it.each([[28], [29], [93]])("wrapper %i has a plain structured message and a plain string, no code or jargon", (code) => {
    const m = resolveUserMessage(fail(code), { surface: "any" });
    expect(m.kind).not.toBe("unmapped");
    expect(`${m.title} ${m.body}`).not.toMatch(/confidence|oracle|0x|Custom\(|capacity|engine|liquidity backs/i);
    expect(V22_ERROR_CODE_MAP[code]).toBeTruthy();
    expect(V22_ERROR_CODE_MAP[code]).not.toMatch(/confidence|oracle account|0x|Custom\(/i);
    expect(humanizeError(raw(code))).toBe(V22_ERROR_CODE_MAP[code]);
  });
  it("93 reads as 'this side is full'", () => {
    expect(resolveUserMessage(fail(93), { surface: "trade", side: "long" })).toMatchObject({ kind: "growth-capacity-full", title: "This side is full" });
  });
  it("flag off: 28 keeps the legacy line (v2.2 copy is flag-gated)", () => {
    __setDevnetV22ForTest(false);
    __setDevnetV21ForTest(false);
    expect(humanizeError(raw(28))).toMatch(/confidence interval/i);
  });
  it("stake program code 29 (no real stakers) is plain, attributed to the stake program only", () => {
    expect(V22_STAKE_ERROR_CODE_MAP[29]).toMatch(/no stakers/i);
    const stake = ids.stake;
    expect(stake).toBeTruthy();
    const m = resolveUserMessage(fail(29, stake), { surface: "stake" });
    expect(m.kind).toBe("stake-no-holders");
    expect(m.body).toBe(V22_STAKE_ERROR_CODE_MAP[29]);
    expect(humanizeError(raw(29, stake))).toBe(V22_STAKE_ERROR_CODE_MAP[29]);
    // negative control: the same number from the wrapper is the wrapper's, not the stake line
    expect(resolveUserMessage(fail(29), { surface: "any" }).body).not.toBe(V22_STAKE_ERROR_CODE_MAP[29]);
  });
  it("a bare 9 off the ticket is plain; ON the ticket it stays unmapped so the chain-state diagnosis still runs", () => {
    expect(resolveUserMessage(fail(9), { surface: "close" }).body).toBe(V22_CUSTOM9_OFF_TICKET);
    expect(humanizeError(raw(9))).toBe(V22_CUSTOM9_OFF_TICKET);
    expect(V22_CUSTOM9_OFF_TICKET).not.toMatch(/matcher|0x|Custom|instruction/i);
    expect(resolveUserMessage(fail(9), { surface: "trade" }).kind).toBe("unmapped");
  });
  it("104 is ONE string, titled 'Close on hold', in the structured and plain paths", () => {
    const m = resolveUserMessage(fail(104), { surface: "close" });
    expect(m.title).toBe("Close on hold");
    expect(m.body).toBe(V22_COPY.band.catchingUp);
    expect(V22_ERROR_CODE_MAP[104]).toBe(V22_COPY.band.catchingUp);
    expect(humanizeError(raw(104))).toBe(m.body);
    expect(m.body).toMatch(/^The price is still catching up after a big move/);
    expect(PERCOLATOR_ERRORS_V22[104].hint).not.toMatch(/seconds/); // the vendored SDK table (upstream wording, details only) promises no seconds
    expect(JSON.stringify(V22_COPY)).not.toContain("pinned at the band edge");
  });
});

describe("items 6 + 7: staking and wizard jargon", () => {
  it("staking copy says it in plain words and keeps the precise term in the tooltip", () => {
    const shown = [STAKE_COPY.sidebar, STAKE_COPY.backStep, STAKE_COPY.risk.lead, STAKE_COPY.risk.flush, STAKE_COPY.risk.tail, STAKE_COPY.waterfallStakeNote].join("\n");
    expect(shown).not.toMatch(/first-loss|flush|insurance capital/i);
    expect(STAKE_COPY.risk.leadTip).toMatch(/first-loss insurance capital/i);
    expect(STAKE_COPY.risk.flushTip).toMatch(/flush/i);
    expect(STAKE_COPY.waterfallStakeTip).toMatch(/flush/i);
  });
  it("the wizard says 'trader payout reserve', with the precise meaning in the tip", () => {
    expect(PAYOUT_RESERVE_COPY.readout).toBe("Incl. trader payout reserve");
    expect(PAYOUT_RESERVE_COPY.readout).not.toMatch(/counterparty|domain/i);
    expect(PAYOUT_RESERVE_COPY.tip).toMatch(/counterparty backing/);
  });
});

describe("item 8: the silent fee-cap retry gets a note after it lands", () => {
  it("says it was raised and by how much", () => {
    expect(feeRaiseCopy({ fromBps: 35n, toBps: 40n })).toContain("raised by 0.05% (to 0.40%)");
    expect(feeRaiseCopy({ fromBps: 30n, toBps: 130n })).toContain("raised by 1.00% (to 1.30%)");
  });
  it("is handed over once, by signature", () => {
    recordFeeRaise("sigA", { fromBps: 35n, toBps: 40n });
    expect(takeFeeRaise("sigA")).toEqual({ fromBps: 35n, toBps: 40n });
    expect(takeFeeRaise("sigA")).toBeNull();
    expect(takeFeeRaise(null)).toBeNull();
  });
  it("negative control: a retry that did not raise the cap records nothing", () => {
    recordFeeRaise("sigB", { fromBps: 40n, toBps: 40n });
    recordFeeRaise("sigC", null);
    expect(takeFeeRaise("sigB")).toBeNull();
    expect(takeFeeRaise("sigC")).toBeNull();
  });
});

describe("item 12 (LEV-4): the 92 copy names a real N", () => {
  it("reads exactly as specified when N is known", () => {
    const m = resolveUserMessage(fail(92), { surface: "trade", maxLeverage: 4.96 });
    expect(`${m.title}: ${m.body}`).toBe("Leverage too high here: The most available at this size right now is 4.96x. Lower the leverage or the size and try again. Closing is never blocked.");
    expect(resolveUserMessage(fail(92), { surface: "trade", maxLeverage: 5 }).body).toContain("is 5x.");
  });
  it("without N it says nothing numeric (no 'undefinedx', no invented figure)", () => {
    const m = resolveUserMessage(fail(92), { surface: "trade" });
    expect(m.body).not.toMatch(/\d+(\.\d+)?x|undefined|NaN/);
  });
});

describe("item 12: N is derived from the post-fill requirement the program checks", () => {
  // The shared growth fixtures are v2.1 market bytes, decoded with the flag off (as lib/v21 tests do).
  beforeEach(() => __setDevnetV22ForTest(false));
  const view = (engine: Partial<typeof ENGINE> = {}, lpQ = -50_000_000n) =>
    growthMarketView({ raw: marketRaw({}), engine: { ...ENGINE, ...engine }, lp: LP, lpEffectiveQ: lpQ, bound: true })!;
  const base = ceilingImrBps(1_000n, 550)!;
  const levAt = (usersAfter: bigint) => Number(leverageX100ForImrBps(dynImrBps(usersAfter, 100_000_000n, base, 5_000n)!)!) / 100;

  it("crowd side: the figure is the requirement AFTER the fill (not the current-OI quote an order can exceed)", () => {
    const v = view({ oiEffLongQ: 80_000_000n });
    const n = growthMaxLeverageForOrder(v, "long", 0n, 10_000_000n);
    expect(n).toBe(levAt(90_000_000n));
    expect(n!).toBeLessThan(v.long.maxLeverageX100 / 100); // strictly below what the stale quote promises
    // what lands: at exactly N the program's requirement (floor(1e6/imr) at the post-fill OI) is met
    const imr = dynImrBps(90_000_000n, 100_000_000n, base, 5_000n)!;
    expect(Math.floor(n! * 100)).toBeLessThanOrEqual(Math.floor(1_000_000 / Number(imr)));
  });
  it("a bigger order lowers N further; a tiny one barely moves it", () => {
    const v = view({ oiEffLongQ: 80_000_000n });
    expect(growthMaxLeverageForOrder(v, "long", 0n, 15_000_000n)!).toBeLessThan(growthMaxLeverageForOrder(v, "long", 0n, 1_000_000n)!);
  });
  it("thin side: the launch ceiling, whatever the size", () => {
    const v = view({ oiEffLongQ: 80_000_000n });
    expect(growthMaxLeverageForOrder(v, "short", 0n, 5_000_000n)).toBe(5.49);
  });
  it("negative controls: a reduce and a zero size give NO figure; an ask past capacity is judged on the CLIPPED fill (lands on N_cap = 1x)", () => {
    const v = view({ oiEffLongQ: 80_000_000n });
    expect(growthMaxLeverageForOrder(v, "short", 5_000_000n, 1_000_000n)).toBeNull(); // reduces a long
    expect(growthMaxLeverageForOrder(v, "long", 0n, 0n)).toBeNull();
    // 110M > N_cap: the program trims the ask to the 20M of room (a fill may land exactly on N_cap, at 100% IMR), it is not refused (QA LEV-8)
    expect(growthMaxLeverageForOrder(v, "long", 0n, 30_000_000n)).toBe(1);
  });
  it("end to end: the resolver prints that very number", () => {
    const v = view({ oiEffLongQ: 80_000_000n });
    const n = growthMaxLeverageForOrder(v, "long", 0n, 10_000_000n)!;
    const m = resolveUserMessage(fail(92), { surface: "trade", maxLeverage: n });
    expect(m.body).toContain(`is ${n}x.`);
    expect(Number.isFinite(n) && n > 1).toBe(true);
  });
});

describe("wiring (source-level, as the U-2 test does for the hooks)", () => {
  const src = (f: string) => readFileSync(path.join(__dirname, "../../..", f), "utf8");
  it("item 8: both trade hooks record the raise, the ticket takes it and renders the note", () => {
    expect(src("hooks/useTrade.ts")).toContain("recordFeeRaise(sig, feeRaise)");
    expect(src("hooks/useFirstTrade.ts")).toContain("recordFeeRaise(signature, feeRaise)");
    const t = src("components/trade/OrderTicket.tsx");
    expect(t).toContain("takeFeeRaise(sig)");
    expect(t).toContain('data-testid="fee-raise-note"');
  });
  it("item 8 on real market bytes: the note's 'by how much' is the real difference between the two caps", () => {
    const FEE = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: Record<string, Record<string, string>> };
    const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
    const m = FEE.markets.SOL;
    const first = resolveTradeFeeBps({ marketData: b64(m.marketB64), matcherCtxData: b64(m.matcherCtxB64) })!;
    const raised = resolveTradeFeeBps({ marketData: b64(m.marketB64), matcherCtxData: b64(m.matcherCtxB64), withUtilMax: true })!;
    const line = feeRaiseCopy({ fromBps: first.feeBps, toBps: raised.feeBps });
    expect(line).toContain(`raised by ${(Number(raised.feeBps - first.feeBps) / 100).toFixed(2)}%`);
    expect(line).toContain(`(to ${(Number(raised.feeBps) / 100).toFixed(2)}%)`);
  });
  it("items 1 + 4 + 12: the ticket reads the market's cap and the 92 figure; the trade page shows the multi-asset notice", () => {
    const t = src("components/trade/OrderTicket.tsx");
    expect(t).toContain("readMaxPortfolioAssets(slabRaw)");
    expect(t).toContain("positionCapCopy(maxPositions)");
    expect(t).toContain("growthMaxLeverageForOrder(");
    expect(t).not.toContain("V22_POSITION_CAP_COPY");
    expect(src("app/trade/[slab]/page.tsx")).toContain("<MultiAssetNotice show={isMultiAssetMarket(slabRaw)}");
  });
  it("item 3: the landing page and the market page take the burn copy from one module", () => {
    expect(src("app/page.tsx")).toContain("ADMIN_BURN_COPY.landing");
    const p = src("app/trade/[slab]/page.tsx");
    expect(p).toContain("ADMIN_BURN_COPY.burned");
    expect(p).not.toMatch(/no one can change/i);
    expect(src("app/page.tsx")).not.toMatch(/no one can change/i);
  });
  it("items 6 + 7: the pages use the plain copy modules", () => {
    expect(src("app/stake/page.tsx")).toContain("STAKE_COPY.risk.lead");
    expect(src("components/trade/AnalyticsDock.tsx")).toContain("STAKE_COPY.waterfallStakeNote");
    expect(src("components/create/StepControlRoom.tsx")).toContain("PAYOUT_RESERVE_COPY.readout");
    expect(src("components/create/LaunchSuccess.tsx")).not.toMatch(/counterparty backing|both domains/i);
  });
});
