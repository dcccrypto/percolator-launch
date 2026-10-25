// @vitest-environment node
/**
 * Market lifecycle state (lib/v22/market-lifecycle.ts): decoded from REAL v2.2 market bytes (CHILLHOUSE-T 56pWj8zY…, wrapper VERSION 19,
 * the fixture lib/v22/stale-resolve.test.ts uses) with the engine fields a Resolved market carries patched in at the keeper's offsets
 * (VERSION 19 group at 592: mode 674, resolved_slot 675, materialized 565, vault 333), then the state derivation and the filter.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_SLICE_LEN,
  RETIRED_VAULT_DUST_ATOMS,
  decodeMarketLifecycleFields,
  deriveMarketLifecycle,
  formatStoppedAt,
  matchesLifecycleFilter,
  parseLifecycleFilter,
  staleLine,
  stoppedAtMs,
  type MarketLifecycleFields,
} from "@/lib/v22/market-lifecycle";

const GROUP = 592;
const MODE = GROUP + 674;
const RESOLVED_SLOT = GROUP + 675;
const MATERIALIZED = GROUP + 565;
const VAULT = GROUP + 333;
const CFG = 16;

const fixture = (): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));

function patched(o: { mode?: number; resolvedSlot?: bigint; materialized?: bigint; vault?: bigint; stale?: bigint; delay?: bigint; lastGood?: bigint }): Uint8Array {
  const d = fixture();
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (o.mode !== undefined) d[MODE] = o.mode;
  if (o.resolvedSlot !== undefined) v.setBigUint64(RESOLVED_SLOT, o.resolvedSlot, true);
  if (o.materialized !== undefined) v.setBigUint64(MATERIALIZED, o.materialized, true);
  if (o.vault !== undefined) {
    v.setBigUint64(VAULT, o.vault & ((1n << 64n) - 1n), true);
    v.setBigUint64(VAULT + 8, o.vault >> 64n, true);
  }
  if (o.stale !== undefined) v.setBigUint64(CFG + 136, o.stale, true);
  if (o.delay !== undefined) v.setBigUint64(CFG + 144, o.delay, true);
  if (o.lastGood !== undefined) v.setBigUint64(CFG + 152, o.lastGood, true);
  return d;
}
const fields = (d: Uint8Array): MarketLifecycleFields => {
  const f = decodeMarketLifecycleFields(d);
  if (!f) throw new Error("fixture did not decode");
  return f;
};
const derive = (f: MarketLifecycleFields | null, clusterSlot: bigint | null = 600_000_000n, blocklisted = false) => deriveMarketLifecycle({ fields: f, clusterSlot, blocklisted });

describe("decode (real CHILLHOUSE-T bytes)", () => {
  it("reads a Live v2.2 market: mode 0, wizard windows 18,000 / 216,000, no resolved slot", () => {
    const f = fields(fixture());
    expect(f.kind).toBe(1);
    expect(f.mode).toBe(0);
    expect(f.staleSlots).toBe(18_000n);
    expect(f.forceCloseDelaySlots).toBe(216_000n);
    expect(f.lastGoodOracleSlot).toBeGreaterThan(511_000_000n);
    expect(f.resolvedSlot).toBe(0n);
  });
  it("a 1,280-byte dataSlice is enough (what the list reads)", () => {
    expect(fields(fixture().slice(0, LIFECYCLE_SLICE_LEN)).mode).toBe(0);
    expect(decodeMarketLifecycleFields(fixture().slice(0, 1270))).toBeNull();
  });
  it("reads the Resolved fields at the keeper's offsets", () => {
    const f = fields(patched({ mode: 1, resolvedSlot: 512_200_000n, materialized: 3n, vault: (1n << 70n) + 5n }));
    expect(f.mode).toBe(1);
    expect(f.resolvedSlot).toBe(512_200_000n);
    expect(f.materializedPortfolios).toBe(3n);
    expect(f.vault).toBe((1n << 70n) + 5n);
  });
  it("is null for foreign bytes, an unknown VERSION and a short buffer; a tombstone decodes as kind 8", () => {
    expect(decodeMarketLifecycleFields(null)).toBeNull();
    expect(decodeMarketLifecycleFields(new Uint8Array(1300))).toBeNull();
    const badVersion = fixture();
    badVersion[8] = 99;
    expect(decodeMarketLifecycleFields(badVersion)).toBeNull();
    const tomb = fixture().slice(0, 64);
    tomb[10] = 8;
    expect(decodeMarketLifecycleFields(tomb)?.kind).toBe(8);
  });
});

describe("state derivation", () => {
  const lastGood = fields(fixture()).lastGoodOracleSlot;
  it("live: price fresh", () => {
    expect(derive(fields(fixture()), lastGood + 100n).state).toBe("live");
  });
  it("stale: exactly on the window; one slot short is still live", () => {
    expect(derive(fields(fixture()), lastGood + 18_000n).state).toBe("stale");
    expect(derive(fields(fixture()), lastGood + 17_999n).state).toBe("live");
    const s = derive(fields(fixture()), lastGood + 20_000n);
    expect(s.staleAgeSlots).toBe(20_000n);
    expect(s.lastGoodOracleSlot).toBe(lastGood);
  });
  it("a market with the stale window off never goes stale; no cluster slot claims nothing", () => {
    expect(derive(fields(patched({ stale: 0n })), lastGood + 99_999_999n).state).toBe("live");
    expect(derive(fields(fixture()), null).state).toBe("live");
  });
  it("settling: Resolved with portfolios still open, owner-only window = resolved_slot + force_close_delay", () => {
    const s = derive(fields(patched({ mode: 1, resolvedSlot: 512_200_000n, materialized: 2n, vault: 9_000_000n })));
    expect(s.state).toBe("settling");
    expect(s.ownerOnlyEndsAtSlot).toBe(512_200_000n + 216_000n);
  });
  it("settling: Recovery mode (its crank reaches Resolved)", () => {
    expect(derive(fields(patched({ mode: 2, materialized: 1n }))).state).toBe("settling");
  });
  it("settled (claims open): Resolved, no portfolio, more than dust in the vault", () => {
    expect(derive(fields(patched({ mode: 1, materialized: 0n, vault: RETIRED_VAULT_DUST_ATOMS + 1n }))).state).toBe("settled");
  });
  it("retired: Resolved, no portfolio, vault at dust (the Earn floor never reaches zero)", () => {
    expect(derive(fields(patched({ mode: 1, materialized: 0n, vault: RETIRED_VAULT_DUST_ATOMS }))).state).toBe("retired");
    expect(derive(fields(patched({ mode: 1, materialized: 0n, vault: 1_005n }))).state).toBe("retired");
  });
  it("retired: a CloseSlab tombstone, and the blocklist (even over a Live read)", () => {
    const tomb = fixture().slice(0, 64);
    tomb[10] = 8;
    expect(derive(fields(tomb)).state).toBe("retired");
    expect(derive(fields(fixture()), lastGood, true).state).toBe("retired");
    expect(derive(null, null, true).state).toBe("retired");
  });
  it("unread / unknown layout: live, nothing claimed", () => {
    expect(derive(null, 1n).state).toBe("live");
  });
  it("a zero force_close_delay has no owner-only window", () => {
    expect(derive(fields(patched({ mode: 1, materialized: 1n, delay: 0n }))).ownerOnlyEndsAtSlot).toBeNull();
  });
});

describe("filter", () => {
  it("default 'all' hides retired only; a named state lists just that state", () => {
    for (const s of ["live", "stale", "settling", "settled"] as const) expect(matchesLifecycleFilter(s, "all")).toBe(true);
    expect(matchesLifecycleFilter("retired", "all")).toBe(false);
    expect(matchesLifecycleFilter("retired", "retired")).toBe(true);
    expect(matchesLifecycleFilter("live", "retired")).toBe(false);
    expect(matchesLifecycleFilter("stale", "stale")).toBe(true);
  });
  it("parses ?state= and ignores junk", () => {
    expect(parseLifecycleFilter("settled")).toBe("settled");
    expect(parseLifecycleFilter("nope")).toBe("all");
    expect(parseLifecycleFilter(null)).toBe("all");
  });
});

describe("copy", () => {
  it("stale line is the plan's wording; funds add the way out", () => {
    expect(staleLine("14:05", false)).toBe("Price stopped at 14:05. Anyone can settle this market.");
    expect(staleLine("14:05", true)).toBe("Price stopped at 14:05. Anyone can settle this market. Settle it to get your funds back.");
  });
  it("stoppedAt is now minus the age at 400 ms a slot; another day carries the date", () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    expect(stoppedAtMs(18_000n, now)).toBe(now - 7_200_000);
    expect(formatStoppedAt(now, now)).not.toMatch(/,/);
    expect(formatStoppedAt(now - 3 * 86_400_000, now)).toMatch(/,/);
  });
});
