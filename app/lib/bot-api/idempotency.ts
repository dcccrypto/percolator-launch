/**
 * Idempotency for bot-API POSTs (`Idempotency-Key` header).
 *
 * Stored per (principal, key) with a hash of the request body for TTL_SEC, longer than a blockhash lives (~60-90 s). The
 * same key with the same body gets the SAME response back, including the same unsigned transaction bytes, so a client
 * that retries and signs again produces the same signature and the cluster dedupes it. Same key, different body: 409
 * idempotency_conflict. Same key while the first is still running: 409 idempotency_in_progress.
 */
import { createHash } from "node:crypto";
import { getKv, type Kv } from "./kv";

export const TTL_SEC = 120;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export function validIdempotencyKey(k: string): boolean {
  return KEY_RE.test(k);
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

type Entry =
  | { h: string; state: "running" }
  | { h: string; state: "done"; res: StoredResponse }
  | { h: string; state: "cancelled"; lastValidBlockHeight: number | null };

export type Begin =
  | { kind: "new" }
  | { kind: "replay"; res: StoredResponse }
  | { kind: "conflict" }
  | { kind: "in_progress" }
  | { kind: "cancelled" };

const k = (principal: string, key: string) => `botapi:idem:${principal}:${key}`;

export async function beginIdempotent(principal: string, key: string, hash: string, kv: Kv = getKv()): Promise<Begin> {
  const fresh: Entry = { h: hash, state: "running" };
  if (await kv.set(k(principal, key), JSON.stringify(fresh), { nx: true, ttlSec: TTL_SEC })) return { kind: "new" };
  const raw = await kv.get(k(principal, key));
  if (!raw) {
    // Expired between the two calls: take it.
    return (await kv.set(k(principal, key), JSON.stringify(fresh), { nx: true, ttlSec: TTL_SEC })) ? { kind: "new" } : { kind: "in_progress" };
  }
  let e: Entry;
  try {
    e = JSON.parse(raw) as Entry;
  } catch {
    return { kind: "conflict" };
  }
  if (e.state === "cancelled") return { kind: "cancelled" };
  if (e.h !== hash) return { kind: "conflict" };
  return e.state === "done" ? { kind: "replay", res: e.res } : { kind: "in_progress" };
}

/** Stores the final response. Only successful builds are kept; an error frees the key so the caller can retry it. */
export async function finishIdempotent(principal: string, key: string, hash: string, res: StoredResponse, kv: Kv = getKv()): Promise<void> {
  if (res.status >= 200 && res.status < 300) {
    const e: Entry = { h: hash, state: "done", res };
    await kv.set(k(principal, key), JSON.stringify(e), { ttlSec: TTL_SEC });
  } else {
    await kv.del(k(principal, key));
  }
}

/**
 * POST /v1/orders/cancel: marks a stored build cancelled so the same key never hands its bytes out again (a replay gets
 * 409 order_cancelled). It cannot recall bytes the client already holds: those can land until their
 * lastValidBlockHeight, which is returned so the client knows when the order is dead for sure.
 */
export async function cancelIdempotent(
  principal: string,
  key: string,
  kv: Kv = getKv(),
): Promise<{ found: false } | { found: true; alreadyCancelled: boolean; lastValidBlockHeight: number | null }> {
  const raw = await kv.get(k(principal, key));
  if (!raw) return { found: false };
  let e: Entry;
  try {
    e = JSON.parse(raw) as Entry;
  } catch {
    return { found: false };
  }
  if (e.state === "cancelled") return { found: true, alreadyCancelled: true, lastValidBlockHeight: e.lastValidBlockHeight };
  const body = e.state === "done" ? (e.res.body as { lastValidBlockHeight?: unknown } | null) : null;
  const lvbh = body && typeof body.lastValidBlockHeight === "number" ? body.lastValidBlockHeight : null;
  const c: Entry = { h: e.h, state: "cancelled", lastValidBlockHeight: lvbh };
  await kv.set(k(principal, key), JSON.stringify(c), { ttlSec: TTL_SEC });
  return { found: true, alreadyCancelled: false, lastValidBlockHeight: lvbh };
}
