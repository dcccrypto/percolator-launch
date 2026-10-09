/**
 * #3314: the taker's ADL-effective position measured before and after a trade, for the saved entry.
 * The leg/market decoders are driven directly (no market fixture is ADL'd); the effective-size
 * math is the real lib/limits/effective-quantity.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  engine: null as unknown,
  legs: [] as unknown[],
}));
vi.mock("@percolatorct/sdk", () => ({ parsePortfolioV17: () => ({ legs: h.legs }) }));
vi.mock("@/lib/limits/decode", () => ({ decodeMarketEngineView: () => h.engine }));

import {
  measurePositionChange,
  readBeforeTrade,
  readEffectivePositionQ,
  recordPositionChange,
  takePositionChange,
} from "@/lib/position-change";

const ADL_ONE = 1_000_000_000_000_000n;
const PF = new PublicKey("22BQsBRbQox5XdZbh2ATmZKEkJkEV8XfVirvHjz7tJ6J");
const MK = new PublicKey("FbC4d6n5yUeKfdGWA1bdnwuHJN4pguaziGq5K544msdH");
const acct = { data: new Uint8Array(8) };

const sides = (aLong = ADL_ONE, aShort = ADL_ONE) => ({ aLong, aShort, epochLong: 3n, epochShort: 3n, modeLong: 0, modeShort: 0 });
const leg = (side: 0 | 1, basis: bigint, aBasis = ADL_ONE, epochSnap = 3n) => ({ active: true, side, basisPosQ: basis, aBasis, epochSnap });

function conn(over: Partial<{ accounts: unknown[]; slot: number | null; fail: boolean }> = {}) {
  const calls: { minContextSlot?: number }[] = [];
  return {
    calls,
    getMultipleAccountsInfo: vi.fn(async (_keys: PublicKey[], cfg: { minContextSlot?: number }) => {
      calls.push(cfg);
      if (over.fail) throw new Error("rpc down");
      return over.accounts ?? [acct, acct];
    }),
    getSignatureStatuses: vi.fn(async () => ({ value: [over.slot === null ? null : { slot: over.slot ?? 500 }] })),
  };
}
type C = Parameters<typeof readEffectivePositionQ>[0];

beforeEach(() => {
  h.engine = sides();
  h.legs = [];
});

describe("readEffectivePositionQ", () => {
  it("a long reads positive, a short negative (no ADL: effective = basis)", async () => {
    h.legs = [leg(0, 40_000_000n)];
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBe(40_000_000n);
    h.legs = [leg(1, 40_000_000n)];
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBe(-40_000_000n);
  });

  it("ADL: reads the EFFECTIVE size, not raw basis", async () => {
    // a_long fell to 0.8 since the leg's a_basis: 100 basis -> 80 effective
    h.engine = sides((ADL_ONE * 8n) / 10n);
    h.legs = [leg(0, 100_000_000n)];
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBe(80_000_000n);
  });

  it("no portfolio or no active leg is flat; a prior-reset obligation owns nothing", async () => {
    expect(await readEffectivePositionQ(conn({ accounts: [null, acct] }) as unknown as C, PF, MK)).toBe(0n);
    h.legs = [{ ...leg(0, 40n), active: false }];
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBe(0n);
    h.engine = { ...sides(), epochLong: 4n, modeLong: 2 }; // ResetPending, leg one epoch behind
    h.legs = [leg(0, 40n)];
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBe(0n);
  });

  it("an unreadable market, an undecodable market, an invalid leg or an RPC error is null", async () => {
    h.legs = [leg(0, 40n)];
    expect(await readEffectivePositionQ(conn({ accounts: [acct, null] }) as unknown as C, PF, MK)).toBeNull();
    h.engine = null;
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBeNull();
    h.engine = sides();
    h.legs = [leg(0, 40n, ADL_ONE, 1n)]; // stale epoch, not a reset obligation
    expect(await readEffectivePositionQ(conn() as unknown as C, PF, MK)).toBeNull();
    h.legs = [leg(0, 40n)];
    expect(await readEffectivePositionQ(conn({ fail: true }) as unknown as C, PF, MK)).toBeNull();
  });
});

describe("measurePositionChange + pinning", () => {
  it("reads after at the trade's own slot, and pins the NEXT before-read past it", async () => {
    h.legs = [leg(0, 80n)];
    const c = conn({ slot: 777 });
    expect(await measurePositionChange(c as unknown as C, PF, MK, "sigA", 40n)).toEqual({ beforeQ: 40n, afterQ: 80n });
    expect(c.calls.at(-1)?.minContextSlot).toBe(777);
    // a second trade right after: its pre-trade read can't be served bytes from before slot 777
    const c2 = conn();
    await readBeforeTrade(c2 as unknown as C, PF, MK);
    expect(c2.calls.at(-1)?.minContextSlot).toBe(777);
  });

  it("unknown before, unknown slot, or an unreadable after is no measurement", async () => {
    h.legs = [leg(0, 80n)];
    expect(await measurePositionChange(conn() as unknown as C, PF, MK, "s", null)).toBeNull();
    expect(await measurePositionChange(conn({ slot: null }) as unknown as C, PF, MK, "s", 40n)).toBeNull();
    expect(await measurePositionChange(conn({ accounts: [acct, null] }) as unknown as C, PF, MK, "s", 40n)).toBeNull();
  });
});

describe("recordPositionChange / takePositionChange", () => {
  it("hands the measurement to the caller once", async () => {
    recordPositionChange("sig1", Promise.resolve({ beforeQ: 0n, afterQ: 5n }));
    expect(await takePositionChange("sig1")).toEqual({ beforeQ: 0n, afterQ: 5n });
    expect(await takePositionChange("sig1")).toBeNull();
    expect(await takePositionChange(null)).toBeNull();
  });

  it("a rejected or hung measurement resolves to null, never throws", async () => {
    recordPositionChange("sig2", Promise.reject(new Error("x")));
    expect(await takePositionChange("sig2")).toBeNull();
    recordPositionChange("sig3", new Promise(() => {}));
    expect(await takePositionChange("sig3", 10)).toBeNull();
  });
});
