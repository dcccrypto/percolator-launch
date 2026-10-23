/**
 * Cost guards for the PUBLIC Earn share routes (`/api/earn-share/<market>` and `/image`). Anyone can request any well-formed key, and each
 * request used to cost an RPC read (and, for the image, a database read, a logo fetch and a render). In order, cheapest first:
 *   1. a query string is not part of the contract and is refused (a `?x=N` would otherwise bypass every CDN / URL-keyed cache);
 *   2. a per-IP bucket on the shared limiter (Upstash when configured, in-memory otherwise), tighter for the image;
 *   3. a negative cache of keys already found unknown;
 *   4. the market must exist in the app's own markets table BEFORE any RPC read (a positive answer is cached too).
 * The rendered PNG is cached per market (`pngCache`), so repeated image requests render once.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { getServiceClient } from "@/lib/supabase";

const jsonLimiter = createUpstashRateLimiter({ limit: 120, windowMs: 60_000, prefix: "rl:earn-share" });
const imageLimiter = createUpstashRateLimiter({ limit: 30, windowMs: 60_000, prefix: "rl:earn-share-image" });

const NEG_TTL_MS = 60_000;
const KNOWN_TTL_MS = 300_000;
const PNG_TTL_MS = 3_600_000;
const MAX_KEYS = 2_000;
const MAX_PNGS = 200;

const negative = new Map<string, number>();
const known = new Map<string, number>();
const pngCache = new Map<string, { at: number; png: Uint8Array }>();

function put<V>(m: Map<string, V>, k: string, v: V, max: number): void {
  if (m.size >= max) m.delete(m.keys().next().value as string);
  m.set(k, v);
}

/** Test seam. */
export function __clearEarnShareGuardForTest(): void {
  negative.clear();
  known.clear();
  pngCache.clear();
}

export const earnShareNotFound = (corsAndCache: Record<string, string>) => NextResponse.json({ error: "not found" }, { status: 404, headers: corsAndCache });

/** `true` when the request carries ANY query string. */
export function hasQuery(req: NextRequest): boolean {
  // `search` is "" for a bare trailing "?", so look at the raw URL too.
  return req.nextUrl.search !== "" || req.url.includes("?");
}

/** `null` = allowed; else the 429 response. */
export async function earnShareRateLimit(req: NextRequest, kind: "json" | "image", headers: Record<string, string>): Promise<NextResponse | null> {
  const r = await (kind === "image" ? imageLimiter : jsonLimiter).check(`${kind}:${getClientIp(req)}`);
  if (r.allowed) return null;
  return NextResponse.json({ error: "too many requests" }, { status: 429, headers: { ...headers, "Retry-After": String(Math.max(1, r.retryAfterSecs)), "Cache-Control": "no-store" } });
}

export type MarketKnown = "known" | "unknown" | "unavailable";

/**
 * Whether `market` is a row of the app's markets table. Zero RPC. `unavailable` (the table could not be read) must NOT fall through to an RPC
 * read: the caller answers 503.
 */
export async function marketIsKnown(market: string): Promise<MarketKnown> {
  const now = Date.now();
  const neg = negative.get(market);
  if (neg !== undefined && now - neg < NEG_TTL_MS) return "unknown";
  const k = known.get(market);
  if (k !== undefined && now - k < KNOWN_TTL_MS) return "known";
  try {
    const { data, error } = await getServiceClient().from("markets").select("slab_address").eq("slab_address", market).single();
    if (!error && data) {
      put(known, market, now, MAX_KEYS);
      return "known";
    }
    // PostgREST answers PGRST116 (no rows) as an error for .single(): that is "unknown"; any other error is "unavailable".
    if (error && (error as { code?: string }).code !== "PGRST116") return "unavailable";
    put(negative, market, now, MAX_KEYS);
    return "unknown";
  } catch {
    return "unavailable";
  }
}

/** Remember a market whose registry was not found on chain, so repeats cost nothing. */
export function rememberUnknown(market: string): void {
  put(negative, market, Date.now(), MAX_KEYS);
}

export function cachedPng(market: string): Uint8Array | null {
  const e = pngCache.get(market);
  return e && Date.now() - e.at < PNG_TTL_MS ? e.png : null;
}
export function cachePng(market: string, png: Uint8Array): void {
  put(pngCache, market, { at: Date.now(), png }, MAX_PNGS);
}
