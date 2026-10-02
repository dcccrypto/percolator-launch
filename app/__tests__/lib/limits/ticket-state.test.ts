// @vitest-environment node
/**
 * UX WP-3 (audit §3.3): the ticket's state machine. One status slot, one state-labelled button,
 * first match wins. Plus the ONE max per side (§4.2, TR-2) and the fee-fit suggestion (row 11).
 */
import { describe, expect, it } from "vitest";
import { balanceMaxQ, deriveTicketState, maxInUnit, oneMaxQ, type TicketStateInput } from "@/lib/limits/ticket-state";
import { ticketRowShortLabel } from "@/lib/limits/ticket-status-store";
import { deriveTicketLimits, feeFitSizeQ } from "@/lib/limits/ticket";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { marketLimits, OWNER_A } from "./fixtures";

const base = (over: Partial<TicketStateInput> = {}): TicketStateInput => ({
  direction: "long",
  baseSymbol: "SOL",
  leverageLabel: "5",
  marketRetired: false,
  marketResolved: false,
  marketPaused: false,
  adlReduceOnly: false,
  engineStale: false,
  waitingForPrice: false,
  sidePaused: { long: false, short: false },
  openingPaused: false,
  sameOwner: false,
  exceedsBalance: false,
  shortfallLabel: "12.50 USDC",
  feeOverMax: false,
  feeSuggested: null,
  ...over,
});

describe("deriveTicketState: the §3.3 priority table", () => {
  it("row 12 ok: '{Long} {SYM} {lev}×', empty slot, not blocking", () => {
    const s = deriveTicketState(base());
    expect(s).toMatchObject({ row: "ok", buttonLabel: "Long SOL 5×", blocks: false, status: null, autoSelect: null });
    expect(deriveTicketState(base({ direction: "short" })).buttonLabel).toBe("Short SOL 5×");
  });

  it("each row: label = state, one calm line, the right variant", () => {
    const rows: Array<[Partial<TicketStateInput>, string, string, string, string]> = [
      [{ marketResolved: true }, "settled", "Market settled", "info", "This market has settled. Close any position and withdraw; there's nothing else to do."],
      [{ adlReduceOnly: true }, "close-only", "Close-only for now", "paused", "Close-only for now after a liquidation. Closing works normally. New positions reopen once the positions on one side have closed, which depends on those traders and can take a while."],
      [{ engineStale: true }, "catching-up", "Waiting for prices…", "wait", "Prices are catching up. Trading resumes automatically, usually within a minute."],
      [{ waitingForPrice: true }, "waiting-price", "Waiting for price…", "wait", "Waiting for a fresh price. This usually takes a few seconds."],
      [{ openingPaused: true }, "both-paused", "Opening paused", "paused", "New positions are paused right now. Closing works normally."],
      [{ sameOwner: true }, "same-owner", "Close-only for this wallet", "paused", "You created this market, so this wallet can only close positions here. Use another wallet to trade it."],
      [{ feeOverMax: true, feeSuggested: "2.5 SOL" }, "fee-over-max", "Reduce size", "error", "This size costs more than the market's maximum fee. Try 2.5 SOL."],
    ];
    for (const [over, row, label, variant, body] of rows) {
      const s = deriveTicketState(base(over));
      expect(s.row, row).toBe(row);
      expect(s.buttonLabel, row).toBe(label);
      expect(s.blocks, row).toBe(true);
      expect(s.status?.variant, row).toBe(variant);
      expect(s.status?.body, row).toBe(body);
    }
  });

  // GH#2882 (SI): the ADL copy promised a reopen "on their own, usually within minutes", and the
  // generic paused copy "until the market's liquidity recovers". With the counterparty out of funds
  // neither happens by itself, and Earn / staking deposits don't refill a non-vault market.
  describe("no funds to take the other side (lpDepleted)", () => {
    it("its own reason, worded for a non-vault market", () => {
      const s = deriveTicketState(base({ lpDepleted: true, openingPaused: true }));
      expect(s.row).toBe("both-paused");
      expect(s.status?.kind).toBe("lp-depleted");
      expect(s.status?.body).toBe(
        "The market has no funds left to take the other side of new trades. Opening resumes once it is funded again; deposits to Earn or staking don't reopen it. Closing works normally.",
      );
    });

    it("a P3 vault-LP market points at the Earn vault instead", () => {
      const s = deriveTicketState(base({ lpDepleted: true, lpIsVault: true, openingPaused: true }));
      expect(s.status?.body).toBe(
        "The market has no funds left to take the other side of new trades. Opening resumes when the Earn vault has funds to back them. Closing works normally.",
      );
    });

    it("close-only and depleted: the close-only line, plus what else reopening needs", () => {
      const s = deriveTicketState(base({ adlReduceOnly: true, lpDepleted: true }));
      expect(s.row).toBe("close-only");
      expect(s.status?.body).toMatch(/^Close-only for now after a liquidation\./);
      expect(s.status?.body).toMatch(/deposits to Earn or staking don't reopen it\.$/);
    });

    it("CONTROL: opening paused for another reason keeps the neutral text", () => {
      const s = deriveTicketState(base({ openingPaused: true }));
      expect(s.status?.kind).toBe("both-paused");
      expect(s.status?.body).toBe("New positions are paused right now. Closing works normally.");
    });

    it("CONTROL: both sides capped, not depleted, keeps the neutral text", () => {
      const s = deriveTicketState(base({ sidePaused: { long: true, short: true } }));
      expect(s.status?.body).toBe("New positions are paused right now. Closing works normally.");
    });
  });

  it("rows 3/4 are waiting rows (the button re-enables itself)", () => {
    expect(deriveTicketState(base({ engineStale: true })).waiting).toBe(true);
    expect(deriveTicketState(base({ waitingForPrice: true })).waiting).toBe(true);
    expect(deriveTicketState(base({ sameOwner: true })).waiting).toBe(false);
  });

  it("row 5: the paused side auto-selects the other; the line names both sides", () => {
    const s = deriveTicketState(base({ sidePaused: { long: true, short: false } }));
    expect(s.row).toBe("side-paused");
    expect(s.autoSelect).toBe("short");
    expect(s.buttonLabel).toBe("New longs paused");
    expect(s.status?.body).toBe(
      "New longs are paused: the market has no room for more long exposure right now. Shorts and closes work. This reopens as positions close.",
    );
    // CONTROL: the open side is not touched
    expect(deriveTicketState(base({ direction: "short", sidePaused: { long: true, short: false } })).row).toBe("ok");
  });

  it("row 6: both sides paused => 'Opening paused', no auto-select", () => {
    const s = deriveTicketState(base({ sidePaused: { long: true, short: true } }));
    expect(s.row).toBe("both-paused");
    expect(s.autoSelect).toBeNull();
  });

  it("row 10: exceeds balance does NOT block; the button says 'Deposit {x} & Long' (one tx, WP-6); no status line", () => {
    const s = deriveTicketState(base({ exceedsBalance: true }));
    expect(s).toMatchObject({ row: "exceeds-balance", buttonLabel: "Deposit 12.50 USDC & Long", blocks: false, status: null });
  });

  it("first match wins: settled > close-only > catching up > price > side paused > same-owner > balance > fee", () => {
    const all = base({
      marketResolved: true, adlReduceOnly: true, engineStale: true, waitingForPrice: true,
      sidePaused: { long: true, short: false }, sameOwner: true, exceedsBalance: true, feeOverMax: true,
    });
    const order = ["settled", "close-only", "catching-up", "waiting-price", "side-paused", "same-owner", "exceeds-balance", "fee-over-max", "ok"];
    const clear: Array<Partial<TicketStateInput>> = [
      { marketResolved: false }, { adlReduceOnly: false }, { engineStale: false }, { waitingForPrice: false },
      { sidePaused: { long: false, short: false } }, { sameOwner: false }, { exceedsBalance: false }, { feeOverMax: false },
    ];
    let cur = all;
    for (let k = 0; k < order.length; k++) {
      expect(deriveTicketState(cur).row).toBe(order[k]);
      if (k < clear.length) cur = { ...cur, ...clear[k] };
    }
  });

  it("no copy leaks protocol words (§5.1)", () => {
    const states: Array<Partial<TicketStateInput>> = [
      { marketRetired: true }, { marketResolved: true }, { marketPaused: true }, { adlReduceOnly: true }, { engineStale: true },
      { waitingForPrice: true }, { sidePaused: { long: true, short: false } }, { openingPaused: true }, { sameOwner: true }, { feeOverMax: true },
    ];
    for (const o of states) {
      const s = deriveTicketState(base(o));
      const text = `${s.buttonLabel} ${s.status?.title} ${s.status?.body}`;
      expect(text).not.toMatch(/\bLP\b|crank|keeper|engine|RebalanceReduce|unilateral|re-?seed|maintainer|Custom|0x[0-9a-f]/i);
    }
  });

  it("the mobile bar's short label: blocked rows only", () => {
    expect(ticketRowShortLabel("close-only")).toBe("Close-only");
    expect(ticketRowShortLabel("settled")).toBe("Settled");
    expect(ticketRowShortLabel("ok")).toBeNull();
    expect(ticketRowShortLabel(null)).toBeNull();
  });
});

describe("one max per side (§4.2, TR-2)", () => {
  it("the tightest cap wins; unlimited / missing caps are ignored", () => {
    expect(oneMaxQ([600_000_000n, 5_000_000_000n, UNLIMITED_CAPACITY])).toBe(600_000_000n);
    expect(oneMaxQ([UNLIMITED_CAPACITY, null, undefined])).toBeNull();
    expect(oneMaxQ([null, 7n])).toBe(7n);
    expect(oneMaxQ([0n, 7n])).toBe(0n); // 0 = a paused side: the ticket hides the figure
  });

  it("balance cap: balance × leverage / price", () => {
    // 100 USDC at 5x, $2 => 250 base
    expect(balanceMaxQ(100_000_000n, 5, 2_000_000n)).toBe(250_000_000n);
    expect(balanceMaxQ(100_000_000n, 6.66, 1_000_000n)).toBe(666_000_000n);
    expect(balanceMaxQ(0n, 5, 1_000_000n)).toBeNull();
    expect(balanceMaxQ(100n, 5, null)).toBeNull();
  });

  it("in the input's unit: base ≤ 4 dp with the token; USD 2 dp floored", () => {
    expect(maxInUnit(41_883_456n, "token", 89_550_000n, "SOL")).toBe("41.8834 SOL");
    expect(maxInUnit(41_883_456n, "usd", 89_550_000n, "SOL")).toBe("$3,750.66");
    expect(maxInUnit(1_000_000n, "token", 1n, "SOL")).toBe("1 SOL");
  });
});

describe("row 11: the fee-fit suggestion", () => {
  const P2 = () =>
    marketLimits({
      matcher: { ...marketLimits().matcher!, inventoryBase: 0n },
      riskLimits: { ...marketLimits().riskLimits!, matcherExtMode: 1, maxRequestedFeeBps: 20 },
      engine: { ...marketLimits().engine!, maxTradingFeeBps: 100n },
    });
  const input = (L = P2(), sizeQ = 100_000_000n) => ({
    limits: L, direction: "long" as const, sizeQ, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 2, limitPriceE6: 0n,
  });
  const over = (L: ReturnType<typeof P2>, q: bigint) =>
    deriveTicketLimits(input(L, q)).issues.some((x) => x.kind === "fee-over-max");

  it("the largest size under the request whose quote fee fits", () => {
    const L = P2();
    expect(over(L, 100_000_000n)).toBe(true); // +31 bps quote > 20 bps protocol max
    const q = feeFitSizeQ(input(L))!;
    expect(q).toBeGreaterThan(0n);
    expect(q).toBeLessThan(100_000_000n);
    expect(over(L, q)).toBe(false);
    expect(over(L, q + 2n)).toBe(true);
  });

  it("CONTROL: when the fee fits there is nothing to suggest", () => {
    const L = marketLimits({
      matcher: { ...marketLimits().matcher!, inventoryBase: 0n },
      riskLimits: { ...marketLimits().riskLimits!, matcherExtMode: 1, maxRequestedFeeBps: 50 },
      engine: { ...marketLimits().engine!, maxTradingFeeBps: 100n },
    });
    expect(over(L, 100_000_000n)).toBe(false);
    expect(feeFitSizeQ(input(L))).toBeNull();
  });
});
