/**
 * Maps one perc_alloc.check_allocation row to the public response for the
 * requested wallet only. Pure. Any row that does not match the expected shape
 * fails closed as "unavailable" rather than showing a guessed figure.
 */
import { EXCLUSION_REASON_LABELS } from "./copy";

export interface CheckRow {
  outcome: string;
  retry_after_seconds: number | null;
  eligible: boolean | null;
  balance_raw: string | null;
  token_decimals: number | null;
  allocation_usd_cents: string | null;
  exclusion_reasons: string[] | null;
  snapshot_label: string | null;
  allocation_status: string | null;
  balance_basis: string | null;
}

export type CheckBody =
  | {
      status: "eligible";
      snapshot: string;
      snapshot_balance: string;
      /** "exception": counted under an approved balance exception, not the snapshot-slot balance */
      balance_basis: "snapshot" | "exception";
      provisional_allocation_usd: string;
      allocation_status: "provisional";
    }
  | { status: "excluded"; snapshot: string; snapshot_balance: string; exclusion_reasons: { code: string; label: string }[] }
  | { status: "not_found"; snapshot: string }
  | { status: "rate_limited"; retry_after_seconds: number }
  | { status: "unavailable"; message: string }
  | { status: "invalid"; error: string };

export const UNAVAILABLE = { status: "unavailable", message: "Allocation checker unavailable. Try again later." } as const;

/** Exact base units -> decimal string, trailing zeros trimmed (no float). */
export function formatUnits(raw: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("bad units");
  if (decimals === 0) return raw;
  const s = raw.padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** Integer cents -> "1234.56" (no float). */
export function formatCents(cents: string): string {
  if (!/^(0|[1-9]\d*)$/.test(cents)) throw new RangeError("bad cents");
  const s = cents.padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

const isLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

export function mapCheckRow(row: CheckRow | undefined): { http: number; body: CheckBody; retryAfter?: number } {
  try {
    if (!row) return { http: 503, body: UNAVAILABLE };
    switch (row.outcome) {
      case "eligible": {
        if (row.eligible !== true || !isLabel(row.snapshot_label) || row.allocation_status !== "provisional") break;
        if (row.balance_raw === null || row.token_decimals === null || row.allocation_usd_cents === null) break;
        if (row.exclusion_reasons && row.exclusion_reasons.length) break;
        if (row.balance_basis !== "snapshot" && row.balance_basis !== "exception") break;
        return {
          http: 200,
          body: {
            status: "eligible",
            snapshot: row.snapshot_label,
            snapshot_balance: formatUnits(row.balance_raw, row.token_decimals),
            balance_basis: row.balance_basis,
            provisional_allocation_usd: formatCents(row.allocation_usd_cents),
            allocation_status: "provisional",
          },
        };
      }
      case "excluded": {
        if (row.eligible !== false || !isLabel(row.snapshot_label) || row.allocation_usd_cents !== null) break;
        if (row.balance_raw === null || row.token_decimals === null) break;
        if (row.balance_basis !== "snapshot") break;
        const codes = row.exclusion_reasons ?? [];
        if (!codes.length || codes.some((c) => !Object.prototype.hasOwnProperty.call(EXCLUSION_REASON_LABELS, c))) break;
        return {
          http: 200,
          body: {
            status: "excluded",
            snapshot: row.snapshot_label,
            snapshot_balance: formatUnits(row.balance_raw, row.token_decimals),
            exclusion_reasons: codes.map((code) => ({ code, label: EXCLUSION_REASON_LABELS[code]! })),
          },
        };
      }
      case "not_found":
        if (!isLabel(row.snapshot_label) || row.balance_raw !== null || row.allocation_usd_cents !== null || row.balance_basis !== null) break;
        return { http: 200, body: { status: "not_found", snapshot: row.snapshot_label } };
      case "rate_limited": {
        const s = row.retry_after_seconds;
        if (!Number.isInteger(s) || (s as number) < 1 || (s as number) > 24 * 60 * 60) break;
        return { http: 429, body: { status: "rate_limited", retry_after_seconds: s as number }, retryAfter: s as number };
      }
      case "invalid":
        return { http: 400, body: { status: "invalid", error: "Invalid wallet address." } };
      default:
        break;
    }
  } catch {
    // formatting refused a malformed figure: fail closed below
  }
  return { http: 503, body: UNAVAILABLE };
}
