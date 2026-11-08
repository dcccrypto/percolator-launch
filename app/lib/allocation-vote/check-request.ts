/**
 * Strict parsing of POST /api/allocation/check bodies: exactly one wallet.
 * Pure (no env, no I/O) so it is unit-testable and shared by the handler.
 */
import { validateOwner } from "./owner";

export const MAX_BODY = 1024;

type Refusal = { ok: false; status: 400 | 413 | 415; error: string };
export type ParsedCheck = { ok: true; owner: string } | Refusal;

const ONE_WALLET = 'Send exactly one wallet as JSON: {"wallet": "<address>"}';

/** Checked before the body is read. */
export function checkEnvelope(contentType: string | null, declaredLength: string | null): Refusal | null {
  if (!/^application\/json(\s*;|$)/i.test(String(contentType ?? "").trim())) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }
  const declared = Number(declaredLength);
  if (declaredLength !== null && Number.isFinite(declared) && declared > MAX_BODY) {
    return { ok: false, status: 413, error: "Request too large" };
  }
  return null;
}

export function parseCheckJson(text: string): ParsedCheck {
  if (text.length > MAX_BODY) return { ok: false, status: 413, error: "Request too large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: 'Body must be JSON {"wallet": "<address>"}' };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400, error: ONE_WALLET };
  const keys = Object.keys(parsed);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "wallet")) return { ok: false, status: 400, error: ONE_WALLET };
  const wallet = (parsed as { wallet?: unknown }).wallet;
  if (Array.isArray(wallet)) return { ok: false, status: 400, error: ONE_WALLET };
  const v = validateOwner(wallet);
  if (!v.ok) return { ok: false, status: 400, error: v.message };
  return { ok: true, owner: v.owner };
}
