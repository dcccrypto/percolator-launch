// @vitest-environment node
/**
 * #3637: a market whose price never connected. Classification from the market bytes, the creation-slot rule, the countdown and
 * the rent copy. Real bytes: CHILLHOUSE-T (see stale-resolve.test.ts) with the stale window / mode / last-good slot patched
 * at the offsets the wrapper uses (percolator-prog aca02ba6 v16_program.rs: HEADER_LEN 16, WrapperConfigV16 first field marketauth,
 * permissionless_resolve_stale_slots +136, last_good_oracle_slot +152).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEVER_CONNECTED_COPY,
  LAUNCH_WAIT_SLOTS,
  NEVER_CONNECTED_FALLBACK_SLACK_SLOTS,
  UNKNOWN_FEATURES,
  marketFeatures,
  recoverSteps,
  formatSlotsAsTime,
  neverConnectedView,
  phaseLine,
  priceNeverAdvanced,
  rentRefundCopy,
} from "@/lib/v22/never-connected";
import { staleResolveStatusV22 } from "@/lib/v22/stale-resolve";
import { resolveMarketGeometry, LAYOUT_V22 } from "@/lib/v22/sdk/layout";

const fixture = (n: string): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, `../../fixtures/v22-growth/${n}.json`), "utf8")) as { data: string }).data, "base64"));

const CFG = LAYOUT_V22.headerLen; // config starts right after the 16-byte header
const STALE_OFF = CFG + 136;
const LAST_GOOD_OFF = CFG + 152;

const CREATED = 1_000_000n;

interface Patch {
  stale?: bigint;
  lastGood?: bigint;
  mode?: number;
}
function market(p: Patch = {}): Uint8Array {
  const m = fixture("chillhouse-t.market").slice();
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  if (p.stale !== undefined) dv.setBigUint64(STALE_OFF, p.stale, true);
  if (p.lastGood !== undefined) dv.setBigUint64(LAST_GOOD_OFF, p.lastGood, true);
  const g = resolveMarketGeometry(m, { parser: "t", strictLength: false });
  // The fixture header clock is a real devnet slot (~512M): bring it to the test's slot space so tag 39's "cluster behind" gate (19) stays out of the way.
  dv.setBigUint64(g.groupOff + g.layout.group.currentSlot, CREATED, true);
  if (p.mode !== undefined) m[g.groupOff + g.layout.group.mode] = p.mode;
  return m;
}


describe("offsets the classifier relies on", () => {
  it("last_good_oracle_slot and the stale window sit where the program puts them (config +152 / +136)", () => {
    const m = market({ stale: 18_000n, lastGood: 123_456_789n });
    const s = staleResolveStatusV22(m, 123_456_789n + 1n)!;
    expect(s.lastGoodOracleSlot).toBe(123_456_789n);
    expect(s.staleSlots).toBe(18_000n);
    expect(LAST_GOOD_OFF).toBe(168);
    expect(STALE_OFF).toBe(152);
  });
});

describe("priceNeverAdvanced (FALLBACK rule, wide slack)", () => {
  it("launch gaps seen on devnet (37, 47, 60, 516 slots) are inside the slack", () => {
    for (const gap of [0n, 37n, 47n, 60n, 516n, NEVER_CONNECTED_FALLBACK_SLACK_SLOTS]) expect(priceNeverAdvanced(CREATED + gap, CREATED)).toBe(true);
  });
  it("one slot past the slack: a price was accepted", () => {
    expect(priceNeverAdvanced(CREATED + NEVER_CONNECTED_FALLBACK_SLACK_SLOTS + 1n, CREATED)).toBe(false);
  });
});

describe("neverConnectedView", () => {
  const old = CREATED + 20_000n;
  it("transaction read says no price was ever pushed: classified whatever the slot gap (37 / 60 / 516)", () => {
    for (const gap of [37n, 60n, 516n, 5_000n]) {
      const m = market({ stale: 18_000n, lastGood: CREATED + gap });
      const v = neverConnectedView({ raw: m, clusterSlot: CREATED + gap + 6_000n, creationSlot: CREATED, neverPushed: true });
      expect(v?.phase).toBe("waiting");
      expect(v?.evidence).toBe("chain");
    }
  });
  it("transaction read says a price WAS pushed: never classified, even with a refusal and a small gap", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED + 5n });
    expect(neverConnectedView({ raw: m, clusterSlot: old, creationSlot: CREATED, neverPushed: false })).toBeNull();
    expect(neverConnectedView({ raw: m, clusterSlot: old, creationSlot: CREATED, neverPushed: false, registrationRefused: true })).toBeNull();
  });
  it("waiting: Live, window not yet passed; the countdown is the window left", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    const v = neverConnectedView({ raw: m, clusterSlot: CREATED + 6_000n, creationSlot: CREATED, neverPushed: true })!;
    expect(v.phase).toBe("waiting");
    expect(v.slotsRemaining).toBe(12_000n);
    expect(phaseLine(v)).toContain("about 1 hour 20 minutes"); // 12,000 slots x 0.4 s = 80 min
  });
  it("settle: exactly at the window passes; one slot short is still waiting", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 18_000n, creationSlot: CREATED, neverPushed: true })!.phase).toBe("settle");
    const short = neverConnectedView({ raw: m, clusterSlot: CREATED + 17_999n, creationSlot: CREATED, neverPushed: true })!;
    expect(short.phase).toBe("waiting");
    expect(short.slotsRemaining).toBe(1n);
  });
  it("no-path: a window of 0 says there is no permissionless path, and no countdown", () => {
    const m = market({ stale: 0n, lastGood: CREATED });
    const v = neverConnectedView({ raw: m, clusterSlot: CREATED + 1_000_000n, creationSlot: CREATED, neverPushed: true })!;
    expect(v.phase).toBe("no-path");
    expect(v.slotsRemaining).toBeNull();
    expect(phaseLine(v)).toMatch(/no permissionless settle window/);
  });
  it("settled: a Resolved market that never connected", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED, mode: 1 });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 30_000n, creationSlot: CREATED, neverPushed: true })!.phase).toBe("settled");
  });
  it("launch-age gate: a young market is not listed on chain evidence alone; a recorded refusal lifts the gate", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    const young = CREATED + LAUNCH_WAIT_SLOTS;
    expect(neverConnectedView({ raw: m, clusterSlot: young, creationSlot: CREATED, neverPushed: true })).toBeNull();
    expect(neverConnectedView({ raw: m, clusterSlot: young + 1n, creationSlot: CREATED, neverPushed: true })).not.toBeNull();
    expect(neverConnectedView({ raw: m, clusterSlot: young, creationSlot: CREATED, neverPushed: true, registrationRefused: true })!.evidence).toBe("chain+registration");
  });
  it("fallback (transaction unreadable): wide slack AND stale; a fresh-looking market is not claimed", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED + 516n });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 516n + 9_000n, creationSlot: CREATED, neverPushed: null })!.evidence).toBe("chain");
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 516n + 8_000n, creationSlot: CREATED, neverPushed: null })).toBeNull(); // not stale enough
    const far = market({ stale: 18_000n, lastGood: CREATED + 5_000n });
    expect(neverConnectedView({ raw: far, clusterSlot: CREATED + 30_000n, creationSlot: CREATED, neverPushed: null })).toBeNull(); // beyond the slack
  });
  it("registration alone (history unreadable): needs the price to be stale today", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 100n, creationSlot: null, registrationRefused: true })).toBeNull();
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 8_999n, creationSlot: null, registrationRefused: true })).toBeNull();
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 9_000n, creationSlot: null, registrationRefused: true })!.evidence).toBe("registration");
    // a refused flag with a CURRENT price (pushed an hour ago relative to the window) does not list it
    const live = market({ stale: 18_000n, lastGood: CREATED + 50_000n });
    expect(neverConnectedView({ raw: live, clusterSlot: CREATED + 50_100n, creationSlot: null, registrationRefused: true })).toBeNull();
  });
  it("unknown evidence claims nothing", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    expect(neverConnectedView({ raw: m, clusterSlot: old, creationSlot: null })).toBeNull();
  });
  it("Recovery mode, no cluster slot, no bytes and foreign bytes claim nothing", () => {
    expect(neverConnectedView({ raw: market({ mode: 2, lastGood: CREATED }), clusterSlot: old, creationSlot: CREATED, neverPushed: true })).toBeNull();
    expect(neverConnectedView({ raw: market({ lastGood: CREATED }), clusterSlot: null, creationSlot: CREATED, neverPushed: true })).toBeNull();
    expect(neverConnectedView({ raw: null, clusterSlot: old, creationSlot: CREATED, neverPushed: true })).toBeNull();
    expect(neverConnectedView({ raw: new Uint8Array(100), clusterSlot: old, creationSlot: CREATED, neverPushed: true })).toBeNull();
  });
});

describe("formatSlotsAsTime", () => {
  it("rounds up, never promising sooner than it is", () => {
    expect(formatSlotsAsTime(0n)).toBe("under a minute");
    expect(formatSlotsAsTime(100n)).toBe("under a minute"); // 40 s
    expect(formatSlotsAsTime(151n)).toBe("about 2 minutes"); // 60.4 s
    expect(formatSlotsAsTime(18_000n)).toBe("about 2 hours");
    expect(formatSlotsAsTime(18_150n)).toBe("about 2 hours 1 minute");
  });
});

describe("rent copy (decision (a), 2026-10-25) is true for what the market has", () => {
  const both = { earn: true, stake: true };
  const main = rentRefundCopy("mainnet", both).join(" ");
  const dev = rentRefundCopy("devnet", both).join(" ");
  it("Earn market: the market account's rent is unrecoverable; stake pool accounts' rent too", () => {
    for (const t of [main, dev]) {
      expect(t).toMatch(/refused while its Earn floor is funded/);
      expect(t).toMatch(/stake pool, vault and LP-mint account rent is not returned/);
    }
  });
  it("mainnet: the treasury refunds the locked rent; no amount, no timing", () => {
    expect(main).toMatch(/treasury refunds that locked rent to the creator of a market whose price never connected/);
    expect(main).not.toMatch(/\bSOL\b|\$|within|hours|days|immediately|apply|form|\bclaim/i);
  });
  it("devnet: no refund is paid, no claim or payment is implied", () => {
    expect(dev).toMatch(/no rent refund is paid/);
    expect(dev).not.toMatch(/treasury|will be refunded|automatic/i);
  });
  it("a market with no Earn pool: the admin can close it and get the rent back (not claimed as sunk)", () => {
    const t = rentRefundCopy("mainnet", { earn: false, stake: false }).join(" ");
    expect(t).toMatch(/admin can close the market account and get its rent back/);
    expect(t).not.toMatch(/refused while its Earn floor|stake pool, vault|treasury/);
  });
  it("no stake pool: no stake-rent wording, but Earn rent still stated", () => {
    const t = rentRefundCopy("devnet", { earn: true, stake: false }).join(" ");
    expect(t).not.toMatch(/stake pool, vault/);
    expect(t).toMatch(/Earn floor/);
  });
  it("fees are not refunded", () => {
    expect(main).toContain(NEVER_CONNECTED_COPY.noFund);
  });
});

describe("the money-back steps link the existing flows, only the ones this market has", () => {
  it("portfolio, Earn (this market), stake", () => {
    expect(recoverSteps(UNKNOWN_FEATURES).map((s) => s.href("SLAB"))).toEqual(["/portfolio", "/earn/SLAB", "/stake"]);
  });
  it("no Earn / no stake hides those steps and renumbers", () => {
    expect(recoverSteps({ earn: false, stake: false }).map((s) => s.id)).toEqual(["portfolio"]);
    expect(recoverSteps({ earn: true, stake: false }).map((s) => s.title)).toEqual(["1. Your own portfolio", "2. Your Earn seed"]);
  });
  it("marketFeatures: unreadable bytes mean both; a real Earn market with admin rotated has both", () => {
    expect(marketFeatures(null, null)).toEqual(UNKNOWN_FEATURES);
    expect(marketFeatures(market({}), null).stake).toBe(true);
  });
});
