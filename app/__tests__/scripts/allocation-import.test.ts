/**
 * Snapshot import validation (operator tooling), SYNTHETIC files only.
 * Every check fails closed and names rows/codes, never owner addresses.
 */
import { describe, expect, it, vi } from "vitest";
import { allocateAll } from "@/lib/allocation-vote/math";
import { ImportError, PUBLISHED_TERMS, sha256Hex, summarize, validateSnapshot, dateLabel, type ImportInput } from "@/scripts/allocation/import-lib";
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
      snapshot: "7 Nov 2026",
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
  return { eligibleCsv, allHoldersCsv, manifest, snapshotDate: "2026-11-07", snapshotSlot: 42n, tokenDecimals: 6 };
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
    expect(v.meta.label).toBe("7 Nov 2026");
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
    ["different floor percent (consistent but not the published 20%)", () => build(base, { manifest: { reserve_percent: 15, reserve_usd: "37500.00" } }), "TERMS_MISMATCH"],
    ["different raise (consistent but not the published $250,000)", () => build(base, { manifest: { full_raise_usd: "300000.00", reserve_usd: "60000.00" } }), "TERMS_MISMATCH"],
    ["not provisional", () => build(base, { manifest: { allocation_status: "final" } }), "STATUS"],
    ["label/date mismatch", () => build(base, { manifest: { snapshot: "8 Nov 2026" } }), "SNAPSHOT_MISMATCH"],
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

  it("rejects a snapshot date other than the published one", () => {
    const i = build(base, { manifest: { snapshot: "8 Nov 2026" } });
    expect(code(() => validateSnapshot({ ...i, snapshotDate: "2026-11-08" }))).toBe("TERMS_MISMATCH");
  });

  it("the public copy states exactly the importer's pinned terms", async () => {
    const { ALLOCATION_COPY } = await import("@/lib/allocation-vote/copy");
    const t = PUBLISHED_TERMS;
    const usd = (c: bigint) => "$" + (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(ALLOCATION_COPY.terms[0]).toContain(`${dateLabel(t.snapshotDate)} snapshot`);
    expect(ALLOCATION_COPY.terms[0]).toContain(`${t.floorPercent}% of the full ${usd(t.fullRaiseCents)} raise (${usd(t.floorCents)})`);
    expect(t.floorCents * 100n).toBe(t.fullRaiseCents * BigInt(t.floorPercent));
  });

  it("rejects bad slot / decimals / date", () => {
    const i = build(base);
    expect(code(() => validateSnapshot({ ...i, snapshotSlot: 0n }))).toBe("BAD_SLOT");
    expect(code(() => validateSnapshot({ ...i, tokenDecimals: 19 }))).toBe("BAD_DECIMALS");
    expect(code(() => validateSnapshot({ ...i, snapshotDate: "2000-02-30" }))).toBe("BAD_DATE");
  });
});

describe("import CLI refuses repository files (realpath)", () => {
  it("a symlink outside the repo that points into it is refused, before anything is read or written", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { main } = await import("@/scripts/allocation/import-snapshot");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-alloc-link-"));
    try {
      const link = path.join(dir, "eligible.csv");
      fs.symlinkSync(path.resolve(__dirname, "../../package.json"), link);
      await expect(
        main(["--eligible", link, "--manifest", link, "--all-holders", link, "--snapshot-date", "2026-11-07", "--snapshot-slot", "1", "--token-decimals", "6"]),
      ).rejects.toThrow(/IN_REPO/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("import CLI database URL", () => {
  it.each(["host=evil.example", "hostaddr=203.0.113.9", "port=6543", "options=-cx", "service=x"])(
    "refuses a URL carrying %s (it could dodge the local/TLS decision)",
    async (param) => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const { main, OVERRIDE_PARAMS } = await import("@/scripts/allocation/import-snapshot");
      const { OVERRIDE_PARAMS: RUNTIME } = await (async () => {
        vi.doMock("server-only", () => ({}));
        return import("@/lib/allocation-vote/server-config");
      })();
      expect(OVERRIDE_PARAMS).toEqual(RUNTIME);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-alloc-url-"));
      try {
        const i = build(base);
        fs.writeFileSync(path.join(dir, "e.csv"), i.eligibleCsv);
        fs.writeFileSync(path.join(dir, "m.json"), i.manifest);
        fs.writeFileSync(path.join(dir, "a.csv"), i.allHoldersCsv);
        process.env.PERC_ALLOC_TEST_DB_URL = `postgresql://migrator:x@127.0.0.1:1/app?${param}`;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(
          main(["--eligible", path.join(dir, "e.csv"), "--manifest", path.join(dir, "m.json"), "--all-holders", path.join(dir, "a.csv"),
            "--snapshot-date", "2026-11-07", "--snapshot-slot", "1", "--token-decimals", "6", "--apply", "--database-url-env", "PERC_ALLOC_TEST_DB_URL"]),
        ).rejects.toThrow(/BAD_DB_URL/);
        log.mockRestore();
      } finally {
        delete process.env.PERC_ALLOC_TEST_DB_URL;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// ─── v2: derived manifest adding approved balance-exception owners ───────────
const ROUNDING_V2 = { mode: "largest_remainder", tie_break: "owner_address_asc", share_decimals: 18, pct_decimals: 12, usd_decimals: 2 };

interface V2Over {
  manifest?: Record<string, unknown>;
  exception?: Record<string, unknown>;
  /** the exception owner also appears in the all-holder file as excluded (newly eligible overrides it) */
  exceptionListedExcluded?: boolean;
  mutateEligible?: (rows: string[][]) => void;
}

function buildV2(fx: Fx, exc: { owner: string; raw: bigint }, over: V2Over = {}): ImportInput {
  const v1 = build(fx);
  const all = [...fx.eligible, exc];
  const owners = all.map((e) => e.owner);
  const raws = all.map((e) => e.raw);
  const total = raws.reduce((a, b) => a + b, 0n);
  const alloc = allocateAll(raws, total, { mode: "largest_remainder", tie_break: "owner_address_asc" }, [
    { key: "share", decimals: 18, total: 1n },
    { key: "pct", decimals: 12, total: 20n },
    { key: "usd", decimals: 2, total: 50000n },
  ], owners);
  const erows = all.map((e, i) => [e.owner, e.raw.toString(), alloc[i]!.share!, alloc[i]!.pct!, alloc[i]!.usd!]);
  over.mutateEligible?.(erows);
  const eligibleCsv = Buffer.from(["owner_address,raw_balance,holder_share,full_raise_percentage,indicative_usd", ...erows.map((r) => r.join(","))].join("\n") + "\n");
  let allHoldersCsv = v1.allHoldersCsv;
  if (over.exceptionListedExcluded) allHoldersCsv = Buffer.concat([allHoldersCsv, Buffer.from(`${exc.owner},0.5,0.1,no,off-curve,\r\n`)]);
  const baseMan = JSON.parse(v1.manifest.toString());
  const manifest = Buffer.from(
    JSON.stringify({
      snapshot: "7 Nov 2026",
      snapshot_slot: 42,
      eligible_owners: all.length,
      previous_eligible_owners: fx.eligible.length,
      reserve_percent: 20,
      reserve_usd: "50000.00",
      totals: { indicative_usd: "50000.00", holder_share: "1.000000000000000000", full_raise_percentage: "20.000000000000" },
      previous_eligible_raw: fx.eligible.reduce((a, e) => a + e.raw, 0n).toString(),
      new_eligible_raw: total.toString(),
      sha256: sha256Hex(eligibleCsv),
      source_sha256: baseMan.sha256,
      override_file: "exception.json",
      rounding: ROUNDING_V2,
      allocation_status: "provisional until raise",
      ...over.manifest,
    }),
  );
  const exception = Buffer.from(
    JSON.stringify({
      type: "owner_exception_override",
      owner_address: exc.owner,
      raw_balance: exc.raw.toString(),
      decimals: 6,
      basis: "SYNTHETIC pre-sale balance",
      authority: "SYNTHETIC owner approval",
      ordinary_snapshot_inclusion: false,
      ...over.exception,
    }),
  );
  return { ...v1, eligibleCsv, allHoldersCsv, manifest, baseManifest: v1.manifest, exceptions: [exception] };
}

const exc = { owner: syntheticOwner("i-exc"), raw: 2_583_406n };

describe("validateSnapshot: derived (v2) manifest with an approved balance exception", () => {
  it("accepts it; the exception owner is eligible with basis 'exception' and the floor sums exactly", () => {
    const v = validateSnapshot(buildV2(base, exc));
    expect(v.eligibleCount).toBe(5);
    expect(v.excludedCount).toBe(3);
    expect(v.holders.filter((h) => h.eligible).reduce((a, h) => a + h.allocationCents, 0n)).toBe(5_000_000n);
    expect(v.holders.find((h) => h.owner === exc.owner)).toMatchObject({ eligible: true, balanceRaw: exc.raw, basis: "exception", reasons: [] });
    expect(v.holders.filter((h) => h.basis === "exception")).toHaveLength(1);
    expect(v.meta.exceptionOwners).toBe(1);
    expect(v.meta.exceptionFilesSha256).toHaveLength(1);
    expect(v.meta.baseManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.meta.teamExclusionBasis).toBe("owner statement: SYNTHETIC source (not independently verified)");
    const s = JSON.stringify(summarize(v));
    expect(s).not.toContain(exc.owner);
  });

  it("an exception owner previously classified as excluded becomes eligible (the exclusion is dropped)", () => {
    const v = validateSnapshot(buildV2(base, exc, { exceptionListedExcluded: true }));
    const rows = v.holders.filter((h) => h.owner === exc.owner);
    expect(rows).toEqual([expect.objectContaining({ eligible: true, basis: "exception", reasons: [], balanceRaw: exc.raw })]);
    expect(v.excludedCount).toBe(3);
  });

  it.each<[string, () => ImportInput, string]>([
    ["no base manifest", () => ({ ...buildV2(base, exc), baseManifest: undefined }), "NO_BASE_MANIFEST"],
    ["no exception file", () => ({ ...buildV2(base, exc), exceptions: [] }), "NO_EXCEPTIONS"],
    ["base manifest is not the source", () => buildV2(base, exc, { manifest: { source_sha256: "0".repeat(64) } }), "BASE_MISMATCH"],
    ["eligible CSV checksum mismatch", () => buildV2(base, exc, { manifest: { sha256: "0".repeat(64) } }), "SHA_MISMATCH"],
    ["owner count off by one", () => buildV2(base, exc, { manifest: { eligible_owners: 6 } }), "COUNT_MISMATCH"],
    ["previous owner count wrong", () => buildV2(base, exc, { manifest: { previous_eligible_owners: 3 } }), "COUNT_MISMATCH"],
    ["floor changed in derived manifest", () => buildV2(base, exc, { manifest: { reserve_usd: "40000.00" } }), "TERMS_MISMATCH"],
    ["declared totals wrong", () => buildV2(base, exc, { manifest: { totals: { indicative_usd: "49999.99", holder_share: "1.000000000000000000", full_raise_percentage: "20.000000000000" } } }), "BAD_MANIFEST"],
    ["new raw total wrong", () => buildV2(base, exc, { manifest: { new_eligible_raw: "1" } }), "RAW_MISMATCH"],
    ["previous raw total wrong", () => buildV2(base, exc, { manifest: { previous_eligible_raw: "1" } }), "RAW_MISMATCH"],
    ["slot differs", () => buildV2(base, exc, { manifest: { snapshot_slot: 43 } }), "SLOT_MISMATCH"],
    ["different rounding", () => buildV2(base, exc, { manifest: { rounding: { ...ROUNDING_V2, usd_decimals: 3 } } }), "BAD_MANIFEST"],
    ["not provisional", () => buildV2(base, exc, { manifest: { allocation_status: "final" } }), "STATUS"],
    ["exception balance differs from the export", () => buildV2(base, exc, { exception: { raw_balance: "1" } }), "BALANCE_MISMATCH"],
    ["exception owner absent from the export", () => buildV2(base, exc, { exception: { owner_address: syntheticOwner("i-nobody") } }), "EXCEPTION_MISSING"],
    ["exception owner not canonical", () => buildV2(base, exc, { exception: { owner_address: "1" + exc.owner } }), "BAD_OWNER"],
    ["exception of unknown type", () => buildV2(base, exc, { exception: { type: "team" } }), "BAD_EXCEPTION"],
    ["exception type that only looks like one", () => buildV2(base, exc, { exception: { type: "x_exception_override; drop" } }), "BAD_EXCEPTION"],
    ["exception without authority", () => buildV2(base, exc, { exception: { authority: " " } }), "BAD_EXCEPTION"],
    ["exception claiming ordinary inclusion", () => buildV2(base, exc, { exception: { ordinary_snapshot_inclusion: true } }), "BAD_EXCEPTION"],
    ["exception with wrong decimals", () => buildV2(base, exc, { exception: { decimals: 9 } }), "BAD_EXCEPTION"],
    ["exception figures not recomputable", () => buildV2(base, exc, { mutateEligible: (r) => { r[4]![4] = (Number(r[4]![4]) + 0.01).toFixed(2); r[0]![4] = (Number(r[0]![4]) - 0.01).toFixed(2); } }), "RECOMPUTE_MISMATCH"],
  ])("refuses: %s", (_l, mk, expected) => {
    const input = mk();
    if (expected !== "SHA_MISMATCH" && expected !== "BASE_MISMATCH") {
      const m = JSON.parse(input.manifest.toString());
      m.sha256 = sha256Hex(input.eligibleCsv);
      input.manifest = Buffer.from(JSON.stringify(m));
    }
    expect(code(() => validateSnapshot(input))).toBe(expected);
  });

  it("refuses an exception owner that is already ordinarily eligible", () => {
    const i = buildV2(base, { owner: base.eligible[0]!.owner, raw: 1_000_000n });
    expect(["DUPLICATE", "EXCEPTION_ALREADY_ELIGIBLE"]).toContain(code(() => validateSnapshot(i)));
  });

  it("refuses exception files or a base manifest with a v1 manifest", () => {
    const v2 = buildV2(base, exc);
    expect(code(() => validateSnapshot({ ...build(base), exceptions: v2.exceptions }))).toBe("UNEXPECTED_INPUT");
    expect(code(() => validateSnapshot({ ...build(base), baseManifest: v2.baseManifest }))).toBe("UNEXPECTED_INPUT");
  });

  it("refuses a derived manifest used as the base (no chaining without provenance)", () => {
    const v2 = buildV2(base, exc);
    expect(code(() => validateSnapshot({ ...v2, baseManifest: v2.manifest }))).toBe("BAD_MANIFEST");
  });
});
