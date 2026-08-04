/**
 * Shared validation for market `symbol` / `name` metadata.
 *
 * On the permissionless launch surface these fields are caller-supplied and are
 * rendered as the market's identity across the UI, so they must reject deceptive
 * or malformed values before being stored:
 *   - symbol: 1–20 chars, alphanumeric / dash / dot / underscore only
 *   - name:   1–64 chars, no control chars, no invisible / bidirectional
 *             formatting chars (RTL overrides, zero-width, etc.)
 *
 * This is the single source of truth. It previously lived inline on the
 * POST /api/markets path only; the launch flow now registers via
 * /api/playground/keeper-register, which must apply the same guards so the two
 * paths cannot drift.
 */
import { hasInvisibleOrBidi } from "@/lib/text-safety";

export const SYMBOL_RE = /^[A-Za-z0-9._\-]{1,20}$/;
export const NAME_MAX_LEN = 64;

export type MetadataCheck = { ok: true } | { ok: false; error: string };

/** Validate an already-resolved symbol string. */
export function checkSymbol(value: string): MetadataCheck {
  if (!SYMBOL_RE.test(value)) {
    return {
      ok: false,
      error: "Invalid symbol: must be 1–20 chars, alphanumeric/dash/dot/underscore only",
    };
  }
  return { ok: true };
}

/** Validate an already-resolved name/label string. */
export function checkName(value: string): MetadataCheck {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > NAME_MAX_LEN) {
    return { ok: false, error: "Invalid name: must be 1–64 characters" };
  }
  // Reject control / non-printable characters.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, error: "Invalid name: must not contain control characters" };
  }
  // Reject invisible / bidirectional formatting characters (RTL overrides,
  // zero-width, etc.) — the name-impersonation vectors. Visible Unicode
  // (accents, CJK, emoji) stays allowed.
  if (hasInvisibleOrBidi(value)) {
    return {
      ok: false,
      error: "Invalid name: must not contain invisible or bidirectional formatting characters",
    };
  }
  return { ok: true };
}

/** Resolve `raw` (or `fallback` when raw is empty/absent), then validate as a symbol. */
export function validateSymbol(
  raw: unknown,
  fallback: string,
): { ok: boolean; error?: string; value?: string } {
  const resolved = typeof raw === "string" && raw.length > 0 ? raw : fallback;
  const r = checkSymbol(resolved);
  return r.ok ? { ok: true, value: resolved } : { ok: false, error: r.error };
}

/** Resolve `raw` (or `fallback` when raw is empty/absent), then validate as a name. */
export function validateName(
  raw: unknown,
  fallback: string,
): { ok: boolean; error?: string; value?: string } {
  const resolved = typeof raw === "string" && raw.length > 0 ? raw : fallback;
  const r = checkName(resolved);
  return r.ok ? { ok: true, value: resolved } : { ok: false, error: r.error };
}
