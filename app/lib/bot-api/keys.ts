/**
 * Bot API keys: `pbk_<keyId>_<secret>`.
 *
 * keyId (12 base58-ish chars) is public and goes in logs and metrics; the secret (32 random bytes, base64url) is shown
 * once at issue and stored only as HMAC-SHA256(secret, BOT_API_KEY_PEPPER). Records live in the bot-API KV under
 * `botapi:key:<keyId>`. A key never grants wallet authority: it lets the caller read and build UNSIGNED transactions;
 * only the wallet's own signature can make one land.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getKv, type Kv } from "./kv";
import { ApiError } from "./errors";

export type Scope = "read" | "build" | "ops";
export type Tier = "default" | "mm";

export interface KeyRecord {
  id: string;
  hash: string;
  scopes: Scope[];
  tier: Tier;
  label: string;
  createdAt: string;
  revoked: boolean;
}

export interface Principal {
  kind: "key" | "anon";
  /** keyId for keys, "ip:<addr>" for anonymous callers. */
  id: string;
  scopes: Scope[];
  tier: Tier | "anon";
}

const KEY_RE = /^pbk_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const recKey = (id: string) => `botapi:key:${id}`;

function pepper(): string {
  const p = process.env.BOT_API_KEY_PEPPER;
  if (p && p.length >= 32) return p;
  // Any deployed build (Vercel sets VERCEL=1) must have its own pepper; no key verifies without it.
  if (process.env.VERCEL) throw new Error("BOT_API_KEY_PEPPER (>= 32 chars) is required on a deployed build");
  // Local / test only: a fixed pepper. Keys issued with it do not verify where a real pepper is set.
  return "bot-api-local-pepper-not-for-deployed-use-0000";
}

export function hashSecret(secret: string): string {
  return createHmac("sha256", pepper()).update(secret).digest("hex");
}

export function parseKey(raw: string): { id: string; secret: string } | null {
  const m = KEY_RE.exec(raw.trim());
  return m ? { id: m[1], secret: m[2] } : null;
}

export async function issueKey(
  opts: { scopes: Scope[]; tier?: Tier; label?: string },
  kv: Kv = getKv(),
): Promise<{ key: string; record: KeyRecord }> {
  const bytes = randomBytes(12);
  const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
  const secret = randomBytes(32).toString("base64url");
  const record: KeyRecord = {
    id,
    hash: hashSecret(secret),
    scopes: [...new Set(opts.scopes)],
    tier: opts.tier ?? "default",
    label: (opts.label ?? "").slice(0, 64),
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  const put = (v: string, o: { nx?: boolean }) => (kv.setAuthoritative ? kv.setAuthoritative(recKey(id), v, o) : kv.set(recKey(id), v, o));
  const ok = await put(JSON.stringify(record), { nx: true });
  if (!ok) throw new Error("key id collision, try again");
  // Read it back from the shared store: a key that is printed must be one the API can verify.
  const back = await getKeyRecord(id, kv);
  if (!back || back.hash !== record.hash) throw new Error(`key ${id} was not stored (the key store did not confirm the write)`);
  return { key: `pbk_${id}_${secret}`, record };
}

export async function revokeKey(id: string, kv: Kv = getKv()): Promise<boolean> {
  const rec = await getKeyRecord(id, kv);
  if (!rec) return false;
  rec.revoked = true;
  const raw = JSON.stringify(rec);
  if (kv.setAuthoritative) await kv.setAuthoritative(recKey(id), raw);
  else await kv.set(recKey(id), raw);
  // Never report a revoke that did not land: re-read the shared record and insist it is revoked.
  const back = await getKeyRecord(id, kv);
  if (!back?.revoked) throw new Error(`key ${id} was NOT revoked (the key store did not confirm the write); it is still live`);
  return true;
}

export async function getKeyRecord(id: string, kv: Kv = getKv()): Promise<KeyRecord | null> {
  let raw: string | null;
  try {
    raw = await (kv.getAuthoritative ? kv.getAuthoritative(recKey(id)) : kv.get(recKey(id)));
  } catch {
    // The lookup itself failed: that is not "no such key". Callers must not count it as an auth failure.
    throw new ApiError("kv_unavailable", undefined, { headers: { "Retry-After": "2" } });
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KeyRecord;
  } catch {
    return null;
  }
}

/**
 * Like verifyKey, and says whether the key id has no usable record (absent or revoked). Only that case may be cached as
 * "missing": a wrong secret on a real key id must never make the real key look missing.
 */
export async function verifyKeyDetailed(raw: string, kv: Kv = getKv()): Promise<{ rec: KeyRecord | null; missingId: string | null }> {
  const p = parseKey(raw);
  if (!p) return { rec: null, missingId: null };
  const rec = await getKeyRecord(p.id, kv);
  if (!rec || rec.revoked) return { rec: null, missingId: p.id };
  const a = Buffer.from(hashSecret(p.secret), "hex");
  const b = Buffer.from(rec.hash, "hex");
  return { rec: a.length === b.length && timingSafeEqual(a, b) ? rec : null, missingId: null };
}

/** The key's record when `raw` is a live key, else null. Constant-time hash compare. */
export async function verifyKey(raw: string, kv: Kv = getKv()): Promise<KeyRecord | null> {
  return (await verifyKeyDetailed(raw, kv)).rec;
}

/** `Authorization: Bearer pbk_...` or `X-API-Key: pbk_...`. */
export function keyFromHeaders(h: Headers): string | null {
  const auth = h.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return h.get("x-api-key")?.trim() || null;
}
