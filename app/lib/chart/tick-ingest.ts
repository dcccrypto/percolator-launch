/**
 * Validation for the keeper -> price-ws tick ingest (contract v1).
 * Pure; the HTTP plumbing lives in scripts/local-price-ws-server.ts.
 */
import { timingSafeEqual } from "node:crypto";
import { MAX_INGEST_TICKS, type IngestBody, type IngestTick } from "./perp-types";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const E6_STRING = /^[1-9][0-9]{0,18}$/;
/** A tick stamped further in the future than this is a bad clock, not data. */
export const MAX_FUTURE_SKEW_MS = 60_000;
/** A tick older than this is not live data (the keeper is replaying or stuck). */
export const MAX_AGE_MS = 60 * 60_000;

export type IngestParse =
  | { ok: true; ticks: IngestTick[]; rejected: number }
  | { ok: false; error: string };

/** Constant-time bearer check. Returns false for a missing/short/wrong token or an unset key. */
export function bearerMatches(header: string | undefined, key: string | undefined): boolean {
  if (!key || key.length < 16 || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function e6ToUsd(e6: string): number {
  // BigInt keeps the 19-digit value exact until the single division; the result is a
  // double, which carries >15 significant digits — far finer than the e6 grid itself.
  return Number(BigInt(e6)) / 1e6;
}

/**
 * Parse an ingest body. Whole-body problems (wrong version, not an array, too many ticks)
 * fail the request; a single bad tick is dropped and counted so one corrupt market
 * cannot stop the others' charts.
 */
export function parseIngestBody(raw: unknown, nowMs: number): IngestParse {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "body must be an object" };
  const b = raw as Partial<IngestBody>;
  if (b.v !== 1) return { ok: false, error: "unsupported version" };
  if (!Array.isArray(b.ticks)) return { ok: false, error: "ticks must be an array" };
  if (b.ticks.length > MAX_INGEST_TICKS) return { ok: false, error: `too many ticks (max ${MAX_INGEST_TICKS})` };
  const ticks: IngestTick[] = [];
  let rejected = 0;
  for (const t of b.ticks as unknown[]) {
    const x = t as Partial<IngestTick> | null;
    const ok =
      x !== null && typeof x === "object" &&
      typeof x.slab === "string" && BASE58.test(x.slab) &&
      Number.isSafeInteger(x.slot) && (x.slot as number) >= 0 &&
      Number.isSafeInteger(x.landedMs) &&
      (x.landedMs as number) <= nowMs + MAX_FUTURE_SKEW_MS &&
      (x.landedMs as number) >= nowMs - MAX_AGE_MS &&
      typeof x.markE6 === "string" && E6_STRING.test(x.markE6) &&
      (x.oracleE6 === null || x.oracleE6 === undefined || (typeof x.oracleE6 === "string" && E6_STRING.test(x.oracleE6)));
    if (!ok) { rejected++; continue; }
    ticks.push({
      slab: x.slab as string,
      assetIndex: Number.isSafeInteger(x.assetIndex) ? (x.assetIndex as number) : 0,
      slot: x.slot as number,
      landedMs: x.landedMs as number,
      markE6: x.markE6 as string,
      oracleE6: (x.oracleE6 as string | null | undefined) ?? null,
    });
  }
  return { ok: true, ticks, rejected };
}
