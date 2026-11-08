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

export interface HolderRow {
  owner: string;
  eligible: boolean;
  balanceRaw: bigint;
  allocationCents: bigint;
  reasons: string[];
}

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
  let man: Record<string, unknown>;
  try {
    man = JSON.parse(input.manifest.toString("utf8"));
  } catch {
    fail("BAD_MANIFEST", "manifest is not JSON");
  }
  if (!man || typeof man !== "object") fail("BAD_MANIFEST", "manifest is not an object");
  const label = dateLabel(input.snapshotDate);
  if (man.snapshot !== label) fail("SNAPSHOT_MISMATCH", "manifest snapshot label does not match the snapshot date");
  if (man.allocation_status !== "provisional until raise") fail("STATUS", "manifest allocation_status must be 'provisional until raise'");
  if (typeof man.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(man.sha256)) fail("BAD_MANIFEST", "manifest sha256 missing");
  if (!Number.isInteger(man.eligible_owners) || (man.eligible_owners as number) <= 0) fail("BAD_MANIFEST", "eligible_owners");
  if (!Number.isInteger(man.reserve_percent) || (man.reserve_percent as number) <= 0 || (man.reserve_percent as number) > 100)
    fail("BAD_MANIFEST", "reserve_percent must be an integer percent");
  const fullRaiseCents = usdToCents(String(man.full_raise_usd), "full_raise_usd");
  const floorCents = usdToCents(String(man.reserve_usd), "reserve_usd");
  const pct = BigInt(man.reserve_percent as number);
  if (floorCents * 100n !== fullRaiseCents * pct) fail("FLOOR_MISMATCH", "reserve_usd is not reserve_percent of full_raise_usd");
  const team = man.team_exclusion as Record<string, unknown> | undefined;
  if (!team || typeof team.basis !== "string" || typeof team.source !== "string" || typeof team.independently_verified !== "boolean")
    fail("BAD_MANIFEST", "team_exclusion basis/source/independently_verified required");
  const teamExclusionBasis = `${team.basis}: ${team.source}${team.independently_verified ? "" : " (not independently verified)"}`;

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
    if (f[3] === "yes") {
      yes++;
      if (!e) fail("ELIGIBLE_MISSING", `all-holders row ${row}: eligible here but absent from the eligible export`);
      if (f[4] !== "") fail("REASON_ON_ELIGIBLE", `all-holders row ${row}: eligible row has an exclusion reason`);
      if (raw !== e.raw) fail("BALANCE_MISMATCH", `all-holders row ${row}: balance differs from the eligible export`);
      if (f[5] !== e.usd) fail("USD_MISMATCH", `all-holders row ${row}: allocation differs from the eligible export`);
      holders.push({ owner, eligible: true, balanceRaw: raw, allocationCents: usdToCents(e.usd, "usd"), reasons: [] });
    } else if (f[3] === "no") {
      if (e) fail("EXCLUDED_IN_EXPORT", `all-holders row ${row}: excluded here but present in the eligible export`);
      const reasons = f[4]!.split(";");
      if (f[4] === "" || reasons.some((r) => !(REASON_CODES as readonly string[]).includes(r)) || new Set(reasons).size !== reasons.length)
        fail("BAD_REASON", `all-holders row ${row}: exclusion reason must be known codes`);
      if (f[5] !== "") fail("ALLOCATION_ON_EXCLUDED", `all-holders row ${row}: excluded row has an allocation`);
      holders.push({ owner, eligible: false, balanceRaw: raw, allocationCents: 0n, reasons });
    } else fail("BAD_ELIGIBLE_FLAG", `all-holders row ${row}: eligible must be yes/no`);
  });
  if (yes !== eligible.size) fail("COUNT_MISMATCH", "all-holders eligible count != eligible export rows");

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
  };
}

const BATCH = 1000;

/**
 * Write one snapshot atomically. Verifies the inserted totals inside the same
 * transaction before superseding the active snapshot; any mismatch or
 * constraint failure rolls everything back.
 */
export async function applySnapshot(client: ClientBase, v: ValidatedSnapshot): Promise<{ snapshotId: number; superseded: number[] }> {
  const m = v.meta;
  await client.query("begin");
  try {
    await client.query("lock table perc_alloc.snapshot in exclusive mode");
    const ins = await client.query(
      `insert into perc_alloc.snapshot
        (label, snapshot_date, snapshot_slot, token_decimals, allocation_status, full_raise_usd_cents, floor_percent,
         floor_usd_cents, eligible_owners, excluded_owners, eligible_raw_total, eligible_csv_sha256,
         all_holders_csv_sha256, manifest_sha256, team_exclusion_basis, team_exclusion_verified)
       values ($1, $2, $3, $4, 'provisional', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning id`,
      [
        m.label, m.snapshotDate, m.snapshotSlot.toString(), m.tokenDecimals, m.fullRaiseCents.toString(), m.floorPercent,
        m.floorCents.toString(), v.eligibleCount, v.excludedCount, v.eligibleRawTotal.toString(), m.eligibleCsvSha256,
        m.allHoldersCsvSha256, m.manifestSha256, m.teamExclusionBasis, m.teamExclusionVerified,
      ],
    );
    const id: number = ins.rows[0].id;
    for (let i = 0; i < v.holders.length; i += BATCH) {
      const chunk = v.holders.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = chunk.map((h) => {
        const b = params.length;
        params.push(id, h.owner, h.eligible, h.balanceRaw.toString(), h.allocationCents.toString(), h.reasons);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::numeric, $${b + 5}::bigint, $${b + 6}::text[])`;
      });
      await client.query(
        `insert into perc_alloc.holder (snapshot_id, owner, eligible, balance_raw, allocation_usd_cents, exclusion_reasons) values ${tuples.join(",")}`,
        params,
      );
    }
    const chk = await client.query(
      `select count(*)::int as n,
              (count(*) filter (where eligible))::int as ne,
              coalesce(sum(allocation_usd_cents) filter (where eligible), 0)::text as cents,
              coalesce(sum(balance_raw) filter (where eligible), 0)::text as raw
         from perc_alloc.holder where snapshot_id = $1`,
      [id],
    );
    const c = chk.rows[0];
    if (
      c.n !== v.eligibleCount + v.excludedCount ||
      c.ne !== v.eligibleCount ||
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
    return { snapshotId: id, superseded: sup.rows.map((r) => r.id) };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
