/**
 * GAP-12 (decision 2026-10-22, L7): a close refused during band catch-up reads an honest, calm wait with a time estimate from the
 * band / catch-up parameters and the current gap; error 120 (close-only after a partial band liquidation) says what happens next.
 * The estimate is the per-sweep walk: lag / (min(cap x S, band) / S) slots, S = 26 slots between keeper sweeps.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BAND_SWEEP_SLOTS, bandWalkEstimate, catchUpAvailableLine, catchUpEstimate } from "@/lib/limits/catchup-estimate";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { bandCatchUpMs, type BandRentView } from "@/lib/v22/band-rent-state";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { V22_COPY } from "@/lib/v22/copy";
import { V21_COPY } from "@/lib/v21/copy";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const E6 = 1_000_000n;
const view = (cap: bigint, bandBps: number, mark: bigint, target: bigint): BandRentView =>
  ({ band: { enabled: true, bandBps }, price: { capBpsPerSlot: cap, markE6: mark, targetE6: target, lagging: true } }) as unknown as BandRentView;

describe("bandWalkEstimate: lag / (min(cap x S, band) / S)", () => {
  it("cap-limited: a 10% gap at cap 4 walks 104 bps per 26-slot sweep (band 130 does not bind)", () => {
    const e = bandWalkEstimate({ effectiveE6: E6, targetE6: (E6 * 110n) / 100n, capBpsPerSlot: 4n, bandBps: 130, slotMs: 400 })!;
    expect(e.gapBps).toBe(1000);
    expect(e.slots).toBe(Math.ceil(1000 / 104) * BAND_SWEEP_SLOTS); // 10 sweeps = 260 slots
    expect(e.ms).toBe(260 * 400);
  });
  it("band-limited: when band < cap x S the band is the step, so the wait is longer than the cap alone says", () => {
    // cap 10 x 26 = 260 bps per sweep, but the band is 130: 130 bps per sweep.
    const banded = bandWalkEstimate({ effectiveE6: E6, targetE6: (E6 * 120n) / 100n, capBpsPerSlot: 10n, bandBps: 130, slotMs: 400 })!;
    expect(banded.slots).toBe(Math.ceil(2000 / 130) * 26); // 16 sweeps
    const capOnly = bandWalkEstimate({ effectiveE6: E6, targetE6: (E6 * 120n) / 100n, capBpsPerSlot: 10n, slotMs: 400 })!;
    expect(capOnly.slots).toBe(Math.ceil(2000 / 260) * 26); // 8 sweeps
    expect(banded.ms).toBe(2 * capOnly.ms);
  });
  it("matches the plain per-slot estimate to within one sweep when the cap binds", () => {
    const p = { effectiveE6: E6, targetE6: (E6 * 120n) / 100n, capBpsPerSlot: 1n, slotMs: 400 };
    const plain = catchUpEstimate(p)!;
    const walk = bandWalkEstimate({ ...p, bandBps: 64 })!;
    expect(Math.abs(walk.slots - plain.slots)).toBeLessThanOrEqual(2 * BAND_SWEEP_SLOTS);
  });
  it("no gap = 0; no cap or no price = no estimate", () => {
    expect(bandWalkEstimate({ effectiveE6: E6, targetE6: E6, capBpsPerSlot: 1n, bandBps: 130 })).toEqual({ gapBps: 0, slots: 0, ms: 0 });
    expect(bandWalkEstimate({ effectiveE6: E6, targetE6: 2n * E6, capBpsPerSlot: 0n, bandBps: 130 })).toBeNull();
    expect(bandWalkEstimate({ effectiveE6: 0n, targetE6: E6, capBpsPerSlot: 1n })).toBeNull();
  });
});

describe("bandCatchUpMs uses the band, and the close line says the time", () => {
  it("band 64 at cap 4: the band (64) is tighter than 4 x 26 = 104, so a 10% gap takes 16 sweeps (about 3 minutes)", () => {
    const ms = bandCatchUpMs(view(4n, 64, E6, (E6 * 110n) / 100n), 400)!;
    expect(ms).toBe(Math.ceil(1000 / 64) * 26 * 400);
    expect(catchUpAvailableLine(ms, "close")).toBe("The price is still catching up after a big move. Closing is available in about 3 minutes.");
  });
  it("a refused close (104) carries that time; never seconds, never a bare 'a few minutes' when the gap is known", () => {
    const ms = bandCatchUpMs(view(4n, 130, E6, (E6 * 109n) / 100n), 400)!;
    const ids = resolveDevnetProgramIds();
    const err = new Error(`Transaction simulation failed: Error processing Instruction 2: custom program error: 0x68\nProgram ${ids.wrapper} failed: custom program error: 0x68`);
    const msg = resolveUserMessage(err, { surface: "close", catchUpMs: ms });
    expect(msg.variant).toBe("wait");
    expect(msg.body).toMatch(/Closing is available in about \d+ minutes?\.$/);
    expect(msg.body).not.toMatch(/second|few minutes/i);
  });
});

describe("error 120: close-only after a liquidation (L7 D1)", () => {
  const ids = resolveDevnetProgramIds();
  const e120 = new Error(`Transaction simulation failed: Error processing Instruction 2: custom program error: 0x78\nProgram ${ids.wrapper} failed: custom program error: 0x78`);
  it("v2.2: says why, what still works, and when it reopens (calm, no code speak)", () => {
    const m = resolveUserMessage(e120, { surface: "trade" });
    expect(m.kind).toBe("adl-reduce-only");
    expect(m.body).toBe(V22_COPY.band.closeOnlyAfterLiquidation);
    expect(m.body).toMatch(/close-only after a liquidation/);
    expect(m.body).toMatch(/within about an hour/);
    expect(m.body).toMatch(/closed at the market price/);
    expect(m.body).not.toMatch(/\b120\b|0x78|ADL|engine/i);
  });
  it("NEGATIVE CONTROL: with v2.2 off it keeps the v2.1 wording", () => {
    __setDevnetV22ForTest(false);
    // v2.1 growth codes only decode with the v2.1 flag on.
    return import("@/lib/v21/flag").then(({ __setDevnetV21ForTest }) => {
      __setDevnetV21ForTest(true);
      try {
        const m = resolveUserMessage(e120, { surface: "trade" });
        expect(m.body).toBe(`${V21_COPY.lock.closeOnly} ${V21_COPY.lock.closeOnlySub}`);
      } finally {
        __setDevnetV21ForTest(null);
      }
    });
  });
});
