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
  NEVER_CONNECTED_SLACK_SLOTS,
  RECOVER_STEPS,
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

describe("priceNeverAdvanced (the creation-slot rule)", () => {
  it("still at the creation slot, or within the slack: never advanced", () => {
    expect(priceNeverAdvanced(CREATED, CREATED)).toBe(true);
    expect(priceNeverAdvanced(CREATED + NEVER_CONNECTED_SLACK_SLOTS, CREATED)).toBe(true);
  });
  it("one slot past the slack: a price was accepted", () => {
    expect(priceNeverAdvanced(CREATED + NEVER_CONNECTED_SLACK_SLOTS + 1n, CREATED)).toBe(false);
  });
});

describe("neverConnectedView", () => {
  it("waiting: Live, window not yet passed; the countdown is the window left", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    const v = neverConnectedView({ raw: m, clusterSlot: CREATED + 6_000n, creationSlot: CREATED })!;
    expect(v.phase).toBe("waiting");
    expect(v.evidence).toBe("chain");
    expect(v.slotsRemaining).toBe(12_000n);
    expect(phaseLine(v)).toContain("about 1 hour 20 minutes"); // 12,000 slots x 0.4 s = 80 min
  });
  it("settle: exactly at the window passes; one slot short is still waiting", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 18_000n, creationSlot: CREATED })!.phase).toBe("settle");
    const short = neverConnectedView({ raw: m, clusterSlot: CREATED + 17_999n, creationSlot: CREATED })!;
    expect(short.phase).toBe("waiting");
    expect(short.slotsRemaining).toBe(1n);
  });
  it("no-path: a window of 0 says there is no permissionless path, and no countdown", () => {
    const m = market({ stale: 0n, lastGood: CREATED });
    const v = neverConnectedView({ raw: m, clusterSlot: CREATED + 1_000_000n, creationSlot: CREATED })!;
    expect(v.phase).toBe("no-path");
    expect(v.slotsRemaining).toBeNull();
    expect(phaseLine(v)).toMatch(/no permissionless settle window/);
  });
  it("settled: a Resolved market that never connected", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED, mode: 1 });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 30_000n, creationSlot: CREATED })!.phase).toBe("settled");
  });
  it("a price that advanced after creation is NOT never-connected, even when the registration was refused", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED + 500n });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 30_000n, creationSlot: CREATED })).toBeNull();
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 30_000n, creationSlot: CREATED, registrationRefused: true })).toBeNull();
  });
  it("a refusal corroborates the chain read", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 10n, creationSlot: CREATED, registrationRefused: true })!.evidence).toBe("chain+registration");
  });
  it("creation slot unreadable: only a registration refusal classifies it, and the copy says the history could not be read", () => {
    const m = market({ stale: 18_000n, lastGood: CREATED });
    expect(neverConnectedView({ raw: m, clusterSlot: CREATED + 10n, creationSlot: null })).toBeNull();
    const v = neverConnectedView({ raw: m, clusterSlot: CREATED + 10n, creationSlot: null, registrationRefused: true })!;
    expect(v.evidence).toBe("registration");
  });
  it("Recovery mode, no cluster slot, no bytes and foreign bytes claim nothing", () => {
    expect(neverConnectedView({ raw: market({ mode: 2, lastGood: CREATED }), clusterSlot: CREATED, creationSlot: CREATED })).toBeNull();
    expect(neverConnectedView({ raw: market({ lastGood: CREATED }), clusterSlot: null, creationSlot: CREATED })).toBeNull();
    expect(neverConnectedView({ raw: null, clusterSlot: CREATED, creationSlot: CREATED })).toBeNull();
    expect(neverConnectedView({ raw: new Uint8Array(100), clusterSlot: CREATED, creationSlot: CREATED })).toBeNull();
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

describe("rent copy (decision (a), 2026-10-25)", () => {
  const main = rentRefundCopy("mainnet").join(" ");
  const dev = rentRefundCopy("devnet").join(" ");
  it("both clusters say what is sunk on chain", () => {
    for (const t of [main, dev]) expect(t).toMatch(/stake pool, vault and LP-mint account rent/);
  });
  it("mainnet: the treasury refunds the locked rent; no amount, no timing", () => {
    expect(main).toMatch(/treasury refunds that locked rent to the creator of a market whose price never connected/);
    expect(main).not.toMatch(/\bSOL\b|\$|within|hours|days|immediately|apply|form|claim/i);
  });
  it("devnet: no refund is paid, no claim or payment is implied", () => {
    expect(dev).toMatch(/no rent refund is paid/);
    expect(dev).not.toMatch(/treasury|will be refunded|automatic/i);
  });
  it("fees are not refunded", () => {
    expect(main).toContain(NEVER_CONNECTED_COPY.noFund);
  });
});

describe("the money-back steps link the existing flows", () => {
  it("portfolio, Earn (this market), stake; nothing reimplemented", () => {
    expect(RECOVER_STEPS.map((s) => s.href("SLAB"))).toEqual(["/portfolio", "/earn/SLAB", "/stake"]);
  });
});
