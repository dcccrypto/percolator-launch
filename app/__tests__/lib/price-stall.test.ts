// @vitest-environment node
/** v2.2 QA Q-3 / M-2: settled and long-stale markets neither wait nor promise "a few seconds". */
import { describe, expect, it } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SimulationRefusal, waitOnRefusal } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { deriveTicketState, type TicketStateInput } from "@/lib/limits/ticket-state";
import { isLongStale, LONG_STALE_SECS, staleAgeLabel, waitPolicy } from "@/lib/limits/price-stall";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const wrapper = new PublicKey(resolveDevnetProgramIds().wrapper);
const refusal = (code: number) =>
  new SimulationRefusal({ InstructionError: [0, { Custom: code }] }, [`Program ${wrapper.toBase58()} failed: custom program error: 0x${code.toString(16)}`], [
    new TransactionInstruction({ programId: wrapper, keys: [], data: Buffer.from([10]) }),
  ]);
const loop = { attempt: 0, waitDelaysMs: [1, 2], keepWaiting: true, aborted: false };
const PENGU_AGE = 31 * 3600;

describe("Q-3: the wait loop", () => {
  it("waits on a fresh 27 / 21, surfaces at once on a settled market or a price nobody pushes", () => {
    expect(waitOnRefusal(refusal(27), loop)).toBe(true);
    expect(waitOnRefusal(refusal(21), { ...loop, shouldWait: waitPolicy(() => ({ resolved: false, priceAgeSecs: 4 })) })).toBe(true);
    expect(waitOnRefusal(refusal(21), { ...loop, shouldWait: waitPolicy(() => ({ resolved: true, priceAgeSecs: 4 })) })).toBe(false);
    expect(waitOnRefusal(refusal(27), { ...loop, shouldWait: waitPolicy(() => ({ resolved: false, priceAgeSecs: PENGU_AGE })) })).toBe(false);
    expect(waitOnRefusal(refusal(49), loop)).toBe(false);
  });
});

describe("Q-3: messages", () => {
  const trade = { surface: "trade" as const };
  it("resolved 21 / 19 / 27 -> Market settled, no auto-retry", () => {
    for (const c of [21, 19, 27]) {
      const m = resolveUserMessage(refusal(c), { ...trade, health: { resolved: true } });
      expect(m.kind).toBe("market-settled");
      expect(m.autoRetry).toBeFalsy();
    }
  });
  it("27 / 21 on a price 31 h old -> how old the price is, no 'few seconds', no auto-retry", () => {
    for (const c of [27, 21, 19]) {
      const m = resolveUserMessage(refusal(c), { ...trade, priceAgeSecs: PENGU_AGE });
      expect(m.kind).toBe("price-stalled");
      expect(m.body).toContain("31 h");
      expect(m.body).not.toMatch(/few seconds|automatically/);
      expect(m.autoRetry).toBeFalsy();
    }
  });
  it("a fresh 27 keeps the short wait line", () => {
    const m = resolveUserMessage(refusal(27), { ...trade, priceAgeSecs: 20 });
    expect(m.kind).toBe("price-wait");
    expect(m.autoRetry).toBe(true);
  });
});

describe("M-2: the ticket", () => {
  const base: TicketStateInput = {
    direction: "long", baseSymbol: "PENGU", leverageLabel: "2", marketRetired: false, marketResolved: false, marketPaused: false, adlReduceOnly: false,
    engineStale: true, waitingForPrice: true, sidePaused: { long: false, short: false }, openingPaused: false, sameOwner: false, exceedsBalance: false,
    shortfallLabel: "", feeOverMax: false, feeSuggested: null,
  };
  it("long-stale: 'No recent price' (paused, not a wait); recent: 'Catching up'", () => {
    const s = deriveTicketState({ ...base, priceAgeSecs: PENGU_AGE });
    expect(s.row).toBe("price-stalled");
    expect(s.waiting).toBe(false);
    expect(s.status?.body).toContain("31 h");
    expect(deriveTicketState({ ...base, priceAgeSecs: 30 }).row).toBe("catching-up");
    expect(deriveTicketState({ ...base, engineStale: false, priceAgeSecs: 30 }).row).toBe("waiting-price");
  });
  it("labels and threshold", () => {
    expect(isLongStale(LONG_STALE_SECS - 1)).toBe(false);
    expect(isLongStale(LONG_STALE_SECS)).toBe(true);
    expect(isLongStale(null)).toBe(false);
    expect(staleAgeLabel(400)).toBe("6 min");
    expect(staleAgeLabel(3 * 86_400)).toBe("3 days");
  });
});
