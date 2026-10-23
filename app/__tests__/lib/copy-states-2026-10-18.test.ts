// @vitest-environment node
/** v2.2 feature check 2026-10-18 (FIX-APP-COPY): C1 EngineStale on a send, C2 one price-state machine, C3 same-owner, C4 rate limit. */
import { describe, expect, it } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SimulationRefusal } from "@/lib/tx";
import {
  humanizeError,
  isEngineStaleAtSend,
  isRateLimitText,
  isTransientError,
  NETWORK_BUSY_MESSAGE,
  TRADE_PRICES_MOVED_MESSAGE,
} from "@/lib/errorMessages";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { derivePriceState, LONG_STALE_SECS, PRICE_CATCHING_UP } from "@/lib/limits/price-stall";
import { deriveTicketState, type TicketStateInput } from "@/lib/limits/ticket-state";
import { deriveTicketLimits } from "@/lib/limits/ticket";
import { marketHeaderStatus } from "@/lib/market-header-status";
import { healthBadgeState } from "@/components/trade/MarketInfoBar";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import type { HealthBadge, MarketHealthRow } from "@/lib/market-health";
import { marketLimits, OWNER_A } from "./limits/fixtures";

const wrapper = new PublicKey(resolveDevnetProgramIds().wrapper);
const sim = (code: number) =>
  new SimulationRefusal({ InstructionError: [0, { Custom: code }] }, [`Program ${wrapper.toBase58()} failed: custom program error: 0x${code.toString(16)}`], [
    new TransactionInstruction({ programId: wrapper, keys: [], data: Buffer.from([10]) }),
  ]);
const sendFail = (code: number) => `Transaction failed: {"InstructionError":[1,{"Custom":${code}}]}`;
const row = (...ids: HealthBadge["id"][]): MarketHealthRow => ({
  lpCapital: "1000000", lpDepleted: false, payoutHaircutBps: 0, openProfitAtoms: "0", realizableProfitAtoms: "0", lockReasons: [],
  badges: ids.map((id) => ({ id, label: id, tone: "warn" as HealthBadge["tone"], detail: "" })),
});

describe("C1: EngineStale (19) at send time on a close / trade", () => {
  it("says prices moved on, not the withdraw advice", () => {
    for (const raw of [sendFail(19), `Program ${wrapper.toBase58()} failed: custom program error: 0x13`]) {
      const t = humanizeError(raw, "trade");
      expect(t).toBe(TRADE_PRICES_MOVED_MESSAGE);
      expect(t).not.toMatch(/withdraw|close your open position/i);
    }
  });
  it("the generic (non-trade) 19 line is unchanged", () => {
    expect(humanizeError(`Program ${wrapper.toBase58()} failed: custom program error: 0x13`)).toMatch(/withdraw/i);
  });
  it("only a 19 that never confirmed qualifies for the one fresh-prefix resend", () => {
    expect(isEngineStaleAtSend(sendFail(19))).toBe(true);
    expect(isEngineStaleAtSend(sendFail(21))).toBe(false);
    expect(isEngineStaleAtSend("Transaction was not confirmed: confirmation timeout, may still land. Custom(19)")).toBe(false);
  });
});

describe("C2: one price-state machine", () => {
  it("fresh / catching-up / no-recent-price", () => {
    expect(derivePriceState(false, 9999)).toBe("fresh");
    expect(derivePriceState(true, 20)).toBe("catching-up");
    expect(derivePriceState(true, null)).toBe("catching-up");
    expect(derivePriceState(true, LONG_STALE_SECS)).toBe("no-recent-price");
  });
  const age13min = 13 * 60;
  it("header line, chip and ticket agree under 300 s (catching up) and after (no recent price)", () => {
    const young = marketHeaderStatus(row(), 0, { oracleStale: true, priceAgeSecs: 40 });
    expect(young?.kind).toBe("engine-catching-up");
    expect(young?.title).toBe(PRICE_CATCHING_UP.title);
    expect(healthBadgeState(true, false, young)).toBe("catching-up");
    const old = marketHeaderStatus(row("repairable"), 0, { oracleStale: true, priceAgeSecs: age13min });
    expect(old?.kind).toBe("no-recent-price");
    expect(old?.title).toBe("No recent price");
    expect(old?.body).toContain("13 min");
    expect(healthBadgeState(true, false, old)).toBe("no-recent-price");
    // the ticket row for the same facts
    const t = deriveTicketState({ ...baseTicket(), waitingForPrice: true, priceAgeSecs: age13min });
    expect(t.status?.title).toBe(old?.title);
    expect(t.status?.body).toBe(old?.body);
    const ty = deriveTicketState({ ...baseTicket(), waitingForPrice: true, priceAgeSecs: 40 });
    expect(ty.status?.title).toBe(young?.title);
    expect(ty.status?.body).toBe(young?.body);
    expect(ty.buttonLabel).toBe(PRICE_CATCHING_UP.button);
  });
  it("a fresh market, a settled one and a close-only one keep their own line", () => {
    expect(marketHeaderStatus(row(), 0, { oracleStale: false, priceAgeSecs: 3 })).toBeNull();
    expect(marketHeaderStatus(row("resolved"), 0, { oracleStale: true, priceAgeSecs: age13min })?.kind).toBe("resolved");
    expect(marketHeaderStatus(row("adl-reduce-only"), 0, { oracleStale: true, priceAgeSecs: age13min })?.kind).toBe("adl-reduce-only");
    // without price facts the row alone decides, as before
    expect(marketHeaderStatus(row("repairable"))?.kind).toBe("engine-catching-up");
  });
  it("a fresh 27 on the send path reads the same catching-up copy", () => {
    const m = resolveUserMessage(sim(27), { surface: "trade", priceAgeSecs: 20 });
    expect(m.title).toBe(PRICE_CATCHING_UP.title);
    expect(m.body).toBe(PRICE_CATCHING_UP.body);
  });
});

function baseTicket(): TicketStateInput {
  return {
    direction: "long", baseSymbol: "SOL", leverageLabel: "5", marketRetired: false, marketResolved: false, marketPaused: false, adlReduceOnly: false,
    engineStale: false, waitingForPrice: false, sidePaused: { long: false, short: false }, openingPaused: false, sameOwner: false, exceedsBalance: false,
    shortfallLabel: "0", feeOverMax: false, feeSuggested: null,
  };
}

describe("C3: a creator / LP-owner wallet cannot open", () => {
  const creator = (flagsP1: boolean, withRiskLimits: boolean) =>
    deriveTicketLimits({
      limits: marketLimits({ assetAdmin: OWNER_A, flags: { ...marketLimits().flags, p1: flagsP1 }, ...(withRiskLimits ? {} : { riskLimits: null }) }),
      direction: "long", sizeQ: 100_000_000n, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 2, limitPriceE6: 0n,
    });
  it("blocks opens with the P1 flag off, and with risk limits not loaded", () => {
    for (const [p1, rl] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      const t = creator(p1, rl);
      expect(t.sameOwnerCloseOnly, `p1=${p1} rl=${rl}`).toBe(true);
      expect(t.sameOwner, `p1=${p1} rl=${rl}`).toBe(true);
      const st = deriveTicketState({ ...baseTicket(), sameOwner: t.sameOwner, exceedsBalance: true });
      expect(st.row).toBe("same-owner");
      expect(st.blocks).toBe(true);
    }
  });
  it("the creator can still close: room on the reducing side", () => {
    const t = deriveTicketLimits({ limits: marketLimits({ assetAdmin: OWNER_A }), direction: "short", sizeQ: 1n, takerPosQ: 5_000_000n, takerOwner: OWNER_A, leverage: 2, limitPriceE6: 0n });
    expect(t.sameOwner).toBe(false);
  });
  it("Custom 67 (send or sim) is a calm line, never blank", () => {
    expect(humanizeError(sendFail(67), "trade")).toMatch(/close positions/i);
    const m = resolveUserMessage(sim(67), { surface: "trade" });
    expect(m.kind).toBe("same-owner");
    expect(m.body.length).toBeGreaterThan(10);
  });
});

describe("C4: RPC rate limit", () => {
  it("maps the provider wording to one calm line", () => {
    for (const raw of ["Connection rate limits exceeded", "429 Too Many Requests", "Error: HTTP 429: rate limit exceeded", '{"code":-32429,"message":"x"}']) {
      expect(isRateLimitText(raw), raw).toBe(true);
      expect(humanizeError(raw, "trade"), raw).toBe(NETWORK_BUSY_MESSAGE);
    }
    expect(NETWORK_BUSY_MESSAGE).toBe("The network is busy; nothing was sent. Try again in a moment.");
  });
  it("the ticket resolver says it too, not 'Something went wrong'", () => {
    const m = resolveUserMessage(new Error("Connection rate limits exceeded"), { surface: "trade" });
    expect(m.kind).toBe("network-busy");
    expect(m.body).toBe(NETWORK_BUSY_MESSAGE);
  });
  it("a bare 429 inside a signature is not a rate limit", () => {
    expect(isRateLimitText("Transaction 5x429abcDEF failed")).toBe(false);
    expect(isRateLimitText("confirmation timeout 429 rate limit may still land")).toBe(false);
    expect(isTransientError("Connection rate limits exceeded")).toBe(true); // safe to resend: never accepted
  });
});
