/**
 * Snapshot import validation (operator tooling), SYNTHETIC files only.
 * Every check fails closed and names rows/codes, never owner addresses.
 */
import { describe, expect, it } from "vitest";
import { allocateAll } from "@/lib/allocation-vote/math";
import { ImportError, sha256Hex, summarize, validateSnapshot, dateLabel, type ImportInput } from "@/scripts/allocation/import-lib";
import { syntheticOwner } from "../db/synthetic";

interface Fx {
  eligible: { owner: string; raw: bigint }[];
  excluded: { owner: string; raw: bigint; reason: string }[];
  crlf?: boolean;
}

function fmtBal(raw: bigint, d = 6): string {
  const s = raw.toString().padStart(d + 1, "0");
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d);
}

function build(fx: Fx, over: { manifest?: Record<string, unknown>; mutateEligible?: (rows: string[][]) => void; mutateAll?: (rows: string[][]) => void } = {}): ImportInput {
  const owners = fx.eligible.map((e) => e.owner);
  const raws = fx.eligible.map((e) => e.raw);
  const total = raws.reduce((a, b) => a + b, 0n);
  const alloc = allocateAll(raws, total, { mode: "largest_remainder", tie_break: "owner_address_asc" }, [
    { key: "share", decimals: 18, total: 1n },
    { key: "pct", decimals: 12, total: 20n },
    { key: "usd", decimals: 2, total: 50000n },
  ], owners);
  const erows = fx.eligible.map((e, i) => [e.owner, e.raw.toString(), alloc[i]!.share!, alloc[i]!.pct!, alloc[i]!.usd!]);
  over.mutateEligible?.(erows);
  const eligibleCsv = Buffer.from(["owner_address,raw_balance,holder_share,full_raise_percentage,indicative_usd", ...erows.map((r) => r.join(","))].join("\n") + "\n");
  const arows = [
    ...fx.eligible.map((e, i) => [e.owner, fmtBal(e.raw), "0.1", "yes", "", alloc[i]!.usd!]),
    ...fx.excluded.map((x) => [x.owner, fmtBal(x.raw), "0.1", "no", x.reason, ""]),
  ];
  over.mutateAll?.(arows);
  const nl = fx.crlf === false ? "\n" : "\r\n";
  const allHoldersCsv = Buffer.from(["owner,balance,pct_of_supply,eligible,exclusion_reason,provisional_allocation_usd", ...arows.map((r) => r.join(","))].join(nl) + nl);
  const manifest = Buffer.from(
    JSON.stringify({
      snapshot: "1 Jan 2000",
      eligible_owners: fx.eligible.length,
      reserve_percent: 20,
      full_raise_usd: "250000.00",
      reserve_usd: "50000.00",
      allocation_status: "provisional until raise",
      sha256: sha256Hex(eligibleCsv),
      team_exclusion: { basis: "owner statement", source: "SYNTHETIC source", independently_verified: false },
      ...over.manifest,
    }),
  );
  return { eligibleCsv, allHoldersCsv, manifest, snapshotDate: "2000-01-01", snapshotSlot: 42n, tokenDecimals: 6 };
}

// Three equal holders: independent rounding would total 49999.99; largest remainder must give 50000.00.
const base: Fx = {
  eligible: [
    { owner: syntheticOwner("i-1"), raw: 1_000_000n },
    { owner: syntheticOwner("i-2"), raw: 1_000_000n },
    { owner: syntheticOwner("i-3"), raw: 1_000_000n },
    { owner: syntheticOwner("i-4"), raw: 7_123_456n },
  ],
  excluded: [
    { owner: syntheticOwner("i-x1"), raw: 10n, reason: "off-curve;LP" },
    { owner: syntheticOwner("i-x2"), raw: 999_000_000n, reason: "off-curve" },
    { owner: syntheticOwner("i-x3"), raw: 1n, reason: "off-curve;LP;burn" },
  ],
};

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    const msg = (e as Error).message;
    for (const o of [...base.eligible, ...base.excluded]) expect(msg).not.toContain(o.owner);
    return (e as ImportError).code;
  }
  throw new Error("expected an ImportError");
};

describe("validateSnapshot: happy path", () => {
  it("accepts a consistent CRLF all-holder file and returns exact integers", () => {
    const v = validateSnapshot(build(base));
    expect(v.eligibleCount).toBe(4);
    expect(v.excludedCount).toBe(3);
    expect(v.meta.floorCents).toBe(5_000_000n);
    expect(v.meta.label).toBe("1 Jan 2000");
    const cents = v.holders.filter((h) => h.eligible).reduce((a, h) => a + h.allocationCents, 0n);
    expect(cents).toBe(5_000_000n);
    expect(v.holders.find((h) => h.owner === syntheticOwner("i-x1"))).toMatchObject({ eligible: false, balanceRaw: 10n, allocationCents: 0n, reasons: ["off-curve", "LP"] });
    expect(v.meta.teamExclusionBasis).toBe("owner statement: SYNTHETIC source (not independently verified)");
    expect(v.meta.teamExclusionVerified).toBe(false);
  });

  it("accepts LF endings too", () => {
    expect(validateSnapshot(build({ ...base, crlf: false })).eligibleCount).toBe(4);
  });

  it("summary has counts and hashes but no addresses", () => {
    const s = JSON.stringify(summarize(validateSnapshot(build(base))));
    for (const o of [...base.eligible, ...base.excluded]) expect(s).not.toContain(o.owner);
    expect(s).toContain('"eligible_usd_sum":"50000.00"');
  });

  it.each([["2026-11-07", "7 Nov 2026"], ["2000-01-01", "1 Jan 2000"]])("dateLabel(%s) = %s", (a, b) => expect(dateLabel(a)).toBe(b));
});

describe("validateSnapshot: fails closed", () => {
  const swapUsd = (rows: string[][]) => {
    rows[0]![4] = (Number(rows[0]![4]) + 0.01).toFixed(2);
    rows[1]![4] = (Number(rows[1]![4]) - 0.01).toFixed(2);
  };
  it.each<[string, () => ImportInput, string]>([
    ["sha256 mismatch", () => ({ ...build(base), eligibleCsv: Buffer.from(build(base).eligibleCsv.toString() + "\n") }), "SHA_MISMATCH"],
    ["row count != manifest", () => build(base, { manifest: { eligible_owners: 5 } }), "COUNT_MISMATCH"],
    ["floor not 20% of raise", () => build(base, { manifest: { reserve_usd: "37500.00" } }), "FLOOR_MISMATCH"],
    ["not provisional", () => build(base, { manifest: { allocation_status: "final" } }), "STATUS"],
    ["label/date mismatch", () => build(base, { manifest: { snapshot: "2 Jan 2000" } }), "SNAPSHOT_MISMATCH"],
    ["missing team provenance", () => build(base, { manifest: { team_exclusion: undefined } }), "BAD_MANIFEST"],
    ["usd moved between rows (sum intact, recompute differs)", () => build(base, { mutateEligible: swapUsd }), "RECOMPUTE_MISMATCH"],
    ["holder_share altered", () => build(base, { mutateEligible: (r) => (r[0]![2] = "0.1") }), "RECOMPUTE_MISMATCH"],
    ["non-canonical owner (leading zero byte form)", () => build(base, { mutateEligible: (r) => (r[0]![0] = "1" + r[0]![0]) }), "BAD_OWNER"],
    ["owner with whitespace", () => build(base, { mutateEligible: (r) => (r[0]![0] = " " + r[0]![0]) }), "BAD_OWNER"],
    ["duplicate eligible owner", () => build(base, { mutateEligible: (r) => (r[1]![0] = r[0]![0]!) }), "DUPLICATE"],
    ["zero raw balance", () => build(base, { mutateEligible: (r) => (r[0]![1] = "0") }), "BAD_BALANCE"],
    ["extra column", () => build(base, { mutateEligible: (r) => r[0]!.push("x") }), "BAD_ROW"],
    ["eligible in all-holders but missing from export", () => build(base, { mutateAll: (r) => (r[0]![0] = syntheticOwner("i-ghost")) }), "ELIGIBLE_MISSING"],
    ["balance mismatch", () => build(base, { mutateAll: (r) => (r[0]![1] = "1.000001") }), "BALANCE_MISMATCH"],
    ["too many balance decimals", () => build(base, { mutateAll: (r) => (r[0]![1] = "1.0000001") }), "BAD_BALANCE"],
    ["usd mismatch", () => build(base, { mutateAll: (r) => (r[0]![5] = "0.00") }), "USD_MISMATCH"],
    ["reason on eligible", () => build(base, { mutateAll: (r) => (r[0]![4] = "LP") }), "REASON_ON_ELIGIBLE"],
    ["excluded with allocation", () => build(base, { mutateAll: (r) => (r[4]![5] = "1.00") }), "ALLOCATION_ON_EXCLUDED"],
    ["unknown reason", () => build(base, { mutateAll: (r) => (r[4]![4] = "team") }), "BAD_REASON"],
    ["empty reason on excluded", () => build(base, { mutateAll: (r) => (r[4]![4] = "") }), "BAD_REASON"],
    ["duplicate reason", () => build(base, { mutateAll: (r) => (r[4]![4] = "LP;LP") }), "BAD_REASON"],
    ["excluded owner present in export", () => build(base, { mutateAll: (r) => (r[4]![0] = r[0]![0]!) }), "DUPLICATE"],
    ["exported owner marked excluded in all-holders", () => build(base, { mutateAll: (r) => { r[0]![3] = "no"; r[0]![4] = "LP"; r[0]![5] = ""; } }), "EXCLUDED_IN_EXPORT"],
    ["eligible flag garbage", () => build(base, { mutateAll: (r) => (r[4]![3] = "maybe") }), "BAD_ELIGIBLE_FLAG"],
    ["eligible row dropped from all-holders", () => build(base, { mutateAll: (r) => r.splice(0, 1) }), "COUNT_MISMATCH"],
  ])("%s", (_l, mk, expected) => {
    const input = mk();
    // Keep the manifest hash in step with deliberately edited eligible CSVs, except for the hash test itself.
    if (expected !== "SHA_MISMATCH") {
      const m = JSON.parse(input.manifest.toString());
      m.sha256 = sha256Hex(input.eligibleCsv);
      input.manifest = Buffer.from(JSON.stringify(m));
    }
    expect(code(() => validateSnapshot(input))).toBe(expected);
  });

  it("rejects a BOM and stray CRs", () => {
    const i = build(base);
    expect(code(() => validateSnapshot({ ...i, allHoldersCsv: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), i.allHoldersCsv]) }))).toBe("BOM");
    expect(code(() => validateSnapshot({ ...i, allHoldersCsv: Buffer.from(i.allHoldersCsv.toString().replace("\r\n", "\r\r\n")) }))).toBe("STRAY_CR");
  });

  it("rejects bad slot / decimals / date", () => {
    const i = build(base);
    expect(code(() => validateSnapshot({ ...i, snapshotSlot: 0n }))).toBe("BAD_SLOT");
    expect(code(() => validateSnapshot({ ...i, tokenDecimals: 19 }))).toBe("BAD_DECIMALS");
    expect(code(() => validateSnapshot({ ...i, snapshotDate: "2000-02-30" }))).toBe("BAD_DATE");
  });
});
