/**
 * PERC allocation snapshot import: validation + atomic apply.
 *
 * Operator tooling only. Never imported by app routes or pages. Reads the
 * PRIVATE finalized export (eligible CSV + manifest) and the PRIVATE all-holder
 * file (for known exclusion reasons), cross-checks them, independently
 * recomputes every allocation with the exact largest-remainder math, and only
 * then writes one snapshot inside a single transaction that verifies its own
 * totals before it supersedes the active snapshot.
 *
 * Two manifest layouts are accepted:
 *   v1  the finalized export manifest (terms + team-exclusion provenance inline);
 *   v2  a derived export that adds approved balance-exception owners to a v1
 *       export. It names its v1 source by sha256 (`source_sha256`); the v1
 *       manifest (terms, provenance) and every exception file must be supplied
 *       and are cross-checked. All v1 checks still run: checksum, count, unique
 *       canonical owners, exact per-row recomputation and the exact floor sum.
 *
 * Errors name row numbers and codes, never owner addresses.
 */
import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import { validateOwner } from "../../lib/allocation-vote/owner";
import { allocateAll } from "../../lib/allocation-vote/math";

export const ELIGIBLE_HEADER = "owner_address,raw_balance,holder_share,full_raise_percentage,indicative_usd";
export const ALL_HOLDERS_HEADER = "owner,balance,pct_of_supply,eligible,exclusion_reason,provisional_allocation_usd";
export const REASON_CODES = ["off-curve", "LP", "burn"] as const;
const U64_MAX = 18446744073709551615n;
/**
 * The published terms shown on /allocation (lib/allocation-vote/copy.ts). An
 * import whose manifest disagrees is refused, so the page can never state
 * terms that contradict the per-wallet figures. A test ties copy.ts to these.
 */
export const PUBLISHED_TERMS = Object.freeze({ snapshotDate: "2026-11-07", floorPercent: 20, fullRaiseCents: 25_000_000n, floorCents: 5_000_000n });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class ImportError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ImportError";
  }
}

export type BalanceBasis = "snapshot" | "exception";

export interface HolderRow {
  owner: string;
  eligible: boolean;
  balanceRaw: bigint;
  allocationCents: bigint;
  reasons: string[];
  basis: BalanceBasis;
}

/** Rounding the exports use; a v2 manifest must declare exactly this. */
export const ROUNDING = Object.freeze({ mode: "largest_remainder", tie_break: "owner_address_asc", share_decimals: 18, pct_decimals: 12, usd_decimals: 2 });
/** Exception files declare a `<kind>_exception_override` type (the kind is private provenance, never shown). */
export const EXCEPTION_TYPE = /^[a-z][a-z_]{0,40}_exception_override$/;

export interface SnapshotMeta {
  label: string;
  snapshotDate: string;
  snapshotSlot: bigint;
  tokenDecimals: number;
  fullRaiseCents: bigint;
  floorPercent: string;
  floorCents: bigint;
  eligibleCsvSha256: string;
  allHoldersCsvSha256: string;
  manifestSha256: string;
  teamExclusionBasis: string;
  teamExclusionVerified: boolean;
  /** v2 only: approved balance exceptions (private provenance, never returned by the lookup) */
  exceptionOwners: number;
  exceptionBasis: string | null;
  exceptionFilesSha256: string[];
  baseManifestSha256: string | null;
}

export interface ValidatedSnapshot {
  meta: SnapshotMeta;
  holders: HolderRow[];
  eligibleCount: number;
  excludedCount: number;
  eligibleRawTotal: bigint;
}

export interface ImportInput {
  eligibleCsv: Buffer;
  allHoldersCsv: Buffer;
  manifest: Buffer;
  snapshotDate: string;
  snapshotSlot: bigint;
  tokenDecimals: number;
  /** v2 layout: the v1 manifest the derived export was built from */
  baseManifest?: Buffer;
  /** v2 layout: one approved exception file per added owner */
  exceptions?: Buffer[];
}

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function fail(code: string, detail: string): never {
  throw new ImportError(code, detail);
}

/** "2026-11-07" -> "7 Nov 2026" */
export function dateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) fail("BAD_DATE", "snapshot date must be YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) fail("BAD_DATE", "not a calendar date");
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

function lines(buf: Buffer, name: string): string[] {
  const text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) fail("BOM", `${name} starts with a byte-order mark`);
  const out = text.split(/\r?\n/);
  if (out[out.length - 1] === "") out.pop();
  if (out.some((l) => l.includes("\r"))) fail("STRAY_CR", `${name} has a stray carriage return`);
  return out;
}

function usdToCents(s: string, what: string): bigint {
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(s)) fail("BAD_USD", `${what} must be a 2-decimal USD amount`);
  return BigInt(s.replace(".", ""));
}

function centsToUsd(c: bigint): string {
  const s = c.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

function decimalToRaw(s: string, decimals: number, row: number): bigint {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(s);
  if (!m) fail("BAD_BALANCE", `all-holders row ${row}: balance is not a plain decimal`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) fail("BAD_BALANCE", `all-holders row ${row}: more than ${decimals} decimals`);
  return BigInt(m[1]! + frac.padEnd(decimals, "0"));
}

function canonicalOwner(v: string, where: string): string {
  const r = validateOwner(v);
  if (!r.ok || r.owner !== v) fail("BAD_OWNER", `${where}: not a canonical 32-byte base58 address`);
  return v;
}

export function validateSnapshot(input: ImportInput): ValidatedSnapshot {
  const { tokenDecimals: D } = input;
  if (!Number.isInteger(D) || D < 0 || D > 18) fail("BAD_DECIMALS", "token decimals must be 0..18");
  if (typeof input.snapshotSlot !== "bigint" || input.snapshotSlot <= 0n) fail("BAD_SLOT", "snapshot slot must be positive");

  // ── Manifest ──
  const parseJson = (b: Buffer, what: string): Record<string, unknown> => {
    let v: unknown;
    try {
      v = JSON.parse(b.toString("utf8"));
    } catch {
      fail("BAD_MANIFEST", `${what} is not JSON`);
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("BAD_MANIFEST", `${what} is not an object`);
    return v as Record<string, unknown>;
  };
  const man = parseJson(input.manifest, "manifest");
  const derived = "override_file" in man || "source_sha256" in man;
  // Terms and provenance come from the v1 manifest (the derived manifest itself for v1).
  let terms = man;
  let baseManifestSha256: string | null = null;
  if (derived) {
    if (!input.baseManifest) fail("NO_BASE_MANIFEST", "derived (v2) manifest needs the v1 source manifest (--base-manifest)");
    terms = parseJson(input.baseManifest, "base manifest");
    if ("override_file" in terms || "source_sha256" in terms) fail("BAD_MANIFEST", "base manifest must itself be a v1 manifest");
    if (typeof man.source_sha256 !== "string" || terms.sha256 !== man.source_sha256)
      fail("BASE_MISMATCH", "derived manifest source_sha256 does not name the base manifest's eligible CSV");
    baseManifestSha256 = sha256Hex(input.baseManifest);
  } else if (input.baseManifest || input.exceptions?.length) {
    fail("UNEXPECTED_INPUT", "base manifest / exception files are only valid with a derived (v2) manifest");
  }
  const label = dateLabel(input.snapshotDate);
  for (const m of derived ? [man, terms] : [man]) {
    if (m.snapshot !== label) fail("SNAPSHOT_MISMATCH", "manifest snapshot label does not match the snapshot date");
    if (m.allocation_status !== "provisional until raise") fail("STATUS", "manifest allocation_status must be 'provisional until raise'");
    if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) fail("BAD_MANIFEST", "manifest sha256 missing");
    if (!Number.isInteger(m.eligible_owners) || (m.eligible_owners as number) <= 0) fail("BAD_MANIFEST", "eligible_owners");
    if (!Number.isInteger(m.reserve_percent) || (m.reserve_percent as number) <= 0 || (m.reserve_percent as number) > 100)
      fail("BAD_MANIFEST", "reserve_percent must be an integer percent");
  }
  if (derived && (man.reserve_percent !== terms.reserve_percent || man.reserve_usd !== terms.reserve_usd))
    fail("TERMS_MISMATCH", "derived manifest floor differs from its base manifest");
  const fullRaiseCents = usdToCents(String(terms.full_raise_usd), "full_raise_usd");
  const floorCents = usdToCents(String(terms.reserve_usd), "reserve_usd");
  const pct = BigInt(terms.reserve_percent as number);
  if (floorCents * 100n !== fullRaiseCents * pct) fail("FLOOR_MISMATCH", "reserve_usd is not reserve_percent of full_raise_usd");
  if (
    input.snapshotDate !== PUBLISHED_TERMS.snapshotDate ||
    terms.reserve_percent !== PUBLISHED_TERMS.floorPercent ||
    fullRaiseCents !== PUBLISHED_TERMS.fullRaiseCents ||
    floorCents !== PUBLISHED_TERMS.floorCents
  )
    fail("TERMS_MISMATCH", "snapshot date / floor / raise differ from the published terms on /allocation");
  const team = terms.team_exclusion as Record<string, unknown> | undefined;
  if (!team || typeof team.basis !== "string" || typeof team.source !== "string" || typeof team.independently_verified !== "boolean")
    fail("BAD_MANIFEST", "team_exclusion basis/source/independently_verified required");
  const teamExclusionBasis = `${team.basis}: ${team.source}${team.independently_verified ? "" : " (not independently verified)"}`;

  // ── v2: derived-manifest declarations and approved exception files ──
  const exceptions = new Map<string, { raw: bigint; text: string }>();
  const exceptionFilesSha256: string[] = [];
  if (derived) {
    if (man.snapshot_slot !== undefined && String(man.snapshot_slot) !== input.snapshotSlot.toString())
      fail("SLOT_MISMATCH", "derived manifest snapshot_slot differs from --snapshot-slot");
    const r = man.rounding as Record<string, unknown> | undefined;
    if (!r || Object.keys(ROUNDING).some((k) => r[k] !== (ROUNDING as Record<string, unknown>)[k]) || Object.keys(r).length !== Object.keys(ROUNDING).length)
      fail("BAD_MANIFEST", "derived manifest rounding must be exactly the importer's rounding");
    const files = input.exceptions ?? [];
    if (!files.length) fail("NO_EXCEPTIONS", "derived manifest needs its exception file(s) (--exception)");
    for (const [i, b] of files.entries()) {
      const x = parseJson(b, `exception file ${i + 1}`);
      const where = `exception file ${i + 1}`;
      if (typeof x.type !== "string" || !EXCEPTION_TYPE.test(x.type)) fail("BAD_EXCEPTION", `${where}: unknown type`);
      const owner = canonicalOwner(String(x.owner_address ?? ""), where);
      if (typeof x.raw_balance !== "string" || !/^[1-9]\d*$/.test(x.raw_balance) || BigInt(x.raw_balance) > U64_MAX)
        fail("BAD_EXCEPTION", `${where}: raw_balance must be a positive integer string`);
      if (x.decimals !== D) fail("BAD_EXCEPTION", `${where}: decimals differ from the token decimals`);
      if (x.ordinary_snapshot_inclusion !== false) fail("BAD_EXCEPTION", `${where}: must declare ordinary_snapshot_inclusion false`);
      for (const k of ["basis", "authority"]) {
        if (typeof x[k] !== "string" || !(x[k] as string).trim() || (x[k] as string).length > 1500) fail("BAD_EXCEPTION", `${where}: ${k} required`);
      }
      if (exceptions.has(owner)) fail("DUPLICATE", `${where}: duplicate exception owner`);
      exceptions.set(owner, { raw: BigInt(x.raw_balance as string), text: `${String(x.basis).trim()} | authority: ${String(x.authority).trim()}` });
      exceptionFilesSha256.push(sha256Hex(b));
    }
    if (man.eligible_owners !== (terms.eligible_owners as number) + exceptions.size || man.previous_eligible_owners !== terms.eligible_owners)
      fail("COUNT_MISMATCH", "derived manifest owner counts do not equal base owners + exception owners");
  }

  const eligibleSha = sha256Hex(input.eligibleCsv);
  if (eligibleSha !== man.sha256) fail("SHA_MISMATCH", "eligible CSV sha256 does not match the manifest");

  // ── Eligible CSV ──
  const el = lines(input.eligibleCsv, "eligible CSV");
  if (el[0] !== ELIGIBLE_HEADER) fail("BAD_HEADER", "eligible CSV header");
  const eligible = new Map<string, { raw: bigint; share: string; pct: string; usd: string; row: number }>();
  el.slice(1).forEach((l, i) => {
    const row = i + 2;
    const f = l.split(",");
    if (f.length !== 5) fail("BAD_ROW", `eligible row ${row}: expected 5 fields`);
    const owner = canonicalOwner(f[0]!, `eligible row ${row}`);
    if (eligible.has(owner)) fail("DUPLICATE", `eligible row ${row}: duplicate owner`);
    if (!/^[1-9]\d*$/.test(f[1]!)) fail("BAD_BALANCE", `eligible row ${row}: raw_balance`);
    const raw = BigInt(f[1]!);
    if (raw > U64_MAX) fail("BAD_BALANCE", `eligible row ${row}: raw_balance above u64`);
    usdToCents(f[4]!, `eligible row ${row}`);
    eligible.set(owner, { raw, share: f[2]!, pct: f[3]!, usd: f[4]!, row });
  });
  if (eligible.size !== man.eligible_owners) fail("COUNT_MISMATCH", "eligible rows != manifest eligible_owners");

  // Independent recomputation: every column, exact, largest remainder, owner_address ascending ties.
  const owners = [...eligible.keys()];
  const raws = owners.map((o) => eligible.get(o)!.raw);
  const totalRaw = raws.reduce((a, b) => a + b, 0n);
  if (floorCents % 100n !== 0n) fail("FLOOR_MISMATCH", "floor must be a whole-dollar amount for this recomputation");
  const recomputed = allocateAll(raws, totalRaw, { mode: "largest_remainder", tie_break: "owner_address_asc" }, [
    { key: "share", decimals: 18, total: 1n },
    { key: "pct", decimals: 12, total: pct },
    { key: "usd", decimals: 2, total: floorCents / 100n },
  ], owners);
  let sumCents = 0n;
  owners.forEach((o, i) => {
    const e = eligible.get(o)!;
    const r = recomputed[i]!;
    if (r.share !== e.share || r.pct !== e.pct || r.usd !== e.usd)
      fail("RECOMPUTE_MISMATCH", `eligible row ${e.row}: exported figures differ from exact recomputation`);
    sumCents += usdToCents(e.usd, "usd");
  });
  if (sumCents !== floorCents) fail("SUM_MISMATCH", "eligible USD does not sum exactly to the floor");
  for (const [o, x] of exceptions) {
    const e = eligible.get(o);
    if (!e) fail("EXCEPTION_MISSING", "an exception owner is absent from the eligible export");
    if (e.raw !== x.raw) fail("BALANCE_MISMATCH", `eligible row ${e.row}: balance differs from its exception file`);
  }
  if (derived) {
    const t = man.totals as Record<string, unknown> | undefined;
    if (!t || t.indicative_usd !== centsToUsd(floorCents) || t.holder_share !== "1.000000000000000000" || t.full_raise_percentage !== `${pct}.000000000000`)
      fail("BAD_MANIFEST", "derived manifest totals differ from the exact totals");
    if (man.new_eligible_raw !== totalRaw.toString()) fail("RAW_MISMATCH", "derived manifest new_eligible_raw differs from the eligible export");
  }

  // ── All-holder source (for exclusions) ──
  const al = lines(input.allHoldersCsv, "all-holders CSV");
  if (al[0] !== ALL_HOLDERS_HEADER) fail("BAD_HEADER", "all-holders CSV header");
  const seen = new Set<string>();
  const holders: HolderRow[] = [];
  let yes = 0;
  al.slice(1).forEach((l, i) => {
    const row = i + 2;
    const f = l.split(",");
    if (f.length !== 6) fail("BAD_ROW", `all-holders row ${row}: expected 6 fields`);
    const owner = canonicalOwner(f[0]!, `all-holders row ${row}`);
    if (seen.has(owner)) fail("DUPLICATE", `all-holders row ${row}: duplicate owner`);
    seen.add(owner);
    const raw = decimalToRaw(f[1]!, D, row);
    if (raw <= 0n || raw > U64_MAX) fail("BAD_BALANCE", `all-holders row ${row}: balance out of range`);
    const e = eligible.get(owner);
    if (exceptions.has(owner)) {
      // An approved exception supersedes the owner's ordinary classification:
      // it may appear here only as excluded (that classification is dropped); it
      // is inserted below as eligible at its exception balance.
      if (f[3] !== "no") fail("EXCEPTION_ALREADY_ELIGIBLE", `all-holders row ${row}: exception owner is already ordinarily eligible`);
      return;
    }
    if (f[3] === "yes") {
      yes++;
      if (!e) fail("ELIGIBLE_MISSING", `all-holders row ${row}: eligible here but absent from the eligible export`);
      if (f[4] !== "") fail("REASON_ON_ELIGIBLE", `all-holders row ${row}: eligible row has an exclusion reason`);
      if (raw !== e.raw) fail("BALANCE_MISMATCH", `all-holders row ${row}: balance differs from the eligible export`);
      // v2 re-divides the floor, so the all-holder file's USD column is the base
      // export's; the per-row recomputation above is what binds v2 figures.
      if (!derived && f[5] !== e.usd) fail("USD_MISMATCH", `all-holders row ${row}: allocation differs from the eligible export`);
      if (f[5] !== "" && !/^(0|[1-9]\d*)\.\d{2}$/.test(f[5]!)) fail("BAD_USD", `all-holders row ${row}: allocation column`);
      holders.push({ owner, eligible: true, balanceRaw: raw, allocationCents: usdToCents(e.usd, "usd"), reasons: [], basis: "snapshot" });
    } else if (f[3] === "no") {
      if (e) fail("EXCLUDED_IN_EXPORT", `all-holders row ${row}: excluded here but present in the eligible export`);
      const reasons = f[4]!.split(";");
      if (f[4] === "" || reasons.some((r) => !(REASON_CODES as readonly string[]).includes(r)) || new Set(reasons).size !== reasons.length)
        fail("BAD_REASON", `all-holders row ${row}: exclusion reason must be known codes`);
      if (f[5] !== "") fail("ALLOCATION_ON_EXCLUDED", `all-holders row ${row}: excluded row has an allocation`);
      holders.push({ owner, eligible: false, balanceRaw: raw, allocationCents: 0n, reasons, basis: "snapshot" });
    } else fail("BAD_ELIGIBLE_FLAG", `all-holders row ${row}: eligible must be yes/no`);
  });
  if (yes + exceptions.size !== eligible.size) fail("COUNT_MISMATCH", "all-holders eligible count != eligible export rows");
  if (derived) {
    if (yes !== terms.eligible_owners) fail("COUNT_MISMATCH", "all-holders eligible count != base manifest eligible_owners");
    const baseRaw = holders.filter((h) => h.eligible).reduce((a, h) => a + h.balanceRaw, 0n);
    if (man.previous_eligible_raw !== baseRaw.toString()) fail("RAW_MISMATCH", "derived manifest previous_eligible_raw differs from the all-holder file");
  }
  for (const [o, x] of exceptions) {
    holders.push({ owner: o, eligible: true, balanceRaw: x.raw, allocationCents: usdToCents(eligible.get(o)!.usd, "usd"), reasons: [], basis: "exception" });
  }

  return {
    meta: {
      label,
      snapshotDate: input.snapshotDate,
      snapshotSlot: input.snapshotSlot,
      tokenDecimals: D,
      fullRaiseCents,
      floorPercent: pct.toString(),
      floorCents,
      eligibleCsvSha256: eligibleSha,
      allHoldersCsvSha256: sha256Hex(input.allHoldersCsv),
      manifestSha256: sha256Hex(input.manifest),
      teamExclusionBasis,
      teamExclusionVerified: team.independently_verified as boolean,
      exceptionOwners: exceptions.size,
      exceptionBasis: exceptions.size ? [...exceptions.values()].map((x) => x.text).join(" || ").slice(0, 4000) : null,
      exceptionFilesSha256,
      baseManifestSha256,
    },
    holders,
    eligibleCount: eligible.size,
    excludedCount: holders.length - eligible.size,
    eligibleRawTotal: totalRaw,
  };
}

/** Counts/hashes only, safe to print: no owner addresses. */
export function summarize(v: ValidatedSnapshot) {
  return {
    snapshot: v.meta.label,
    snapshot_slot: v.meta.snapshotSlot.toString(),
    token_decimals: v.meta.tokenDecimals,
    eligible_owners: v.eligibleCount,
    excluded_owners: v.excludedCount,
    eligible_raw_total: v.eligibleRawTotal.toString(),
    floor_usd: centsToUsd(v.meta.floorCents),
    full_raise_usd: centsToUsd(v.meta.fullRaiseCents),
    floor_percent: v.meta.floorPercent,
    eligible_usd_sum: centsToUsd(v.holders.filter((h) => h.eligible).reduce((a, h) => a + h.allocationCents, 0n)),
    eligible_csv_sha256: v.meta.eligibleCsvSha256,
    all_holders_csv_sha256: v.meta.allHoldersCsvSha256,
    manifest_sha256: v.meta.manifestSha256,
    team_exclusion: v.meta.teamExclusionBasis,
    exception_owners: v.meta.exceptionOwners,
    exception_files_sha256: v.meta.exceptionFilesSha256,
    base_manifest_sha256: v.meta.baseManifestSha256,
  };
}

const BATCH = 1000;

/**
 * Write one snapshot atomically. Re-runnable: each run inserts a new versioned
 * snapshot, verifies its rows inside the same transaction (count, unique owners,
 * eligible/exception counts, exact cents and raw totals) and only then moves the
 * single active pointer; any mismatch or constraint failure rolls everything
 * back and leaves the previous snapshot active. Re-running the exact same inputs
 * while they are already active is a no-op.
 */
export async function applySnapshot(
  client: ClientBase,
  v: ValidatedSnapshot,
): Promise<{ snapshotId: number; superseded: number[]; unchanged: boolean }> {
  const m = v.meta;
  await client.query("begin");
  try {
    await client.query("lock table perc_alloc.snapshot in exclusive mode");
    const act = await client.query(
      `select id from perc_alloc.snapshot
        where is_active and eligible_csv_sha256 = $1 and all_holders_csv_sha256 = $2 and manifest_sha256 = $3
          and exception_files_sha256 = $4::text[] and base_manifest_sha256 is not distinct from $5
          and snapshot_slot = $6 and snapshot_date = $7::date and token_decimals = $8 and label = $9`,
      [m.eligibleCsvSha256, m.allHoldersCsvSha256, m.manifestSha256, m.exceptionFilesSha256, m.baseManifestSha256,
        m.snapshotSlot.toString(), m.snapshotDate, m.tokenDecimals, m.label],
    );
    if (act.rows.length === 1) {
      await client.query("commit");
      return { snapshotId: act.rows[0].id, superseded: [], unchanged: true };
    }
    const ins = await client.query(
      `insert into perc_alloc.snapshot
        (label, snapshot_date, snapshot_slot, token_decimals, allocation_status, full_raise_usd_cents, floor_percent,
         floor_usd_cents, eligible_owners, excluded_owners, eligible_raw_total, eligible_csv_sha256,
         all_holders_csv_sha256, manifest_sha256, team_exclusion_basis, team_exclusion_verified,
         exception_owners, exception_basis, exception_files_sha256, base_manifest_sha256)
       values ($1, $2, $3, $4, 'provisional', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::text[], $19)
       returning id`,
      [
        m.label, m.snapshotDate, m.snapshotSlot.toString(), m.tokenDecimals, m.fullRaiseCents.toString(), m.floorPercent,
        m.floorCents.toString(), v.eligibleCount, v.excludedCount, v.eligibleRawTotal.toString(), m.eligibleCsvSha256,
        m.allHoldersCsvSha256, m.manifestSha256, m.teamExclusionBasis, m.teamExclusionVerified,
        m.exceptionOwners, m.exceptionBasis, m.exceptionFilesSha256, m.baseManifestSha256,
      ],
    );
    const id: number = ins.rows[0].id;
    for (let i = 0; i < v.holders.length; i += BATCH) {
      const chunk = v.holders.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = chunk.map((h) => {
        const b = params.length;
        params.push(id, h.owner, h.eligible, h.balanceRaw.toString(), h.allocationCents.toString(), h.reasons, h.basis);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::numeric, $${b + 5}::bigint, $${b + 6}::text[], $${b + 7})`;
      });
      await client.query(
        `insert into perc_alloc.holder (snapshot_id, owner, eligible, balance_raw, allocation_usd_cents, exclusion_reasons, balance_basis) values ${tuples.join(",")}`,
        params,
      );
    }
    const chk = await client.query(
      `select count(*)::int as n,
              (count(*) filter (where eligible))::int as ne,
              (count(*) filter (where balance_basis = 'exception'))::int as nx,
              count(distinct owner)::int as nu,
              coalesce(sum(allocation_usd_cents) filter (where eligible), 0)::text as cents,
              coalesce(sum(balance_raw) filter (where eligible), 0)::text as raw
         from perc_alloc.holder where snapshot_id = $1`,
      [id],
    );
    const c = chk.rows[0];
    if (
      c.n !== v.eligibleCount + v.excludedCount ||
      c.ne !== v.eligibleCount ||
      c.nx !== m.exceptionOwners ||
      c.nu !== c.n ||
      c.cents !== m.floorCents.toString() ||
      c.raw !== v.eligibleRawTotal.toString()
    ) {
      throw new ImportError("VERIFY", "verification failed: inserted totals differ from the validated snapshot");
    }
    const sup = await client.query(
      "update perc_alloc.snapshot set is_active = false, superseded_at = now() where is_active returning id",
    );
    await client.query("update perc_alloc.snapshot set is_active = true, activated_at = now() where id = $1", [id]);
    await client.query("commit");
    return { snapshotId: id, superseded: sup.rows.map((r) => r.id), unchanged: false };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
