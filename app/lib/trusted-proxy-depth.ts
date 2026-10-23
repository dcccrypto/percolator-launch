/**
 * #3483: the one parser for TRUSTED_PROXY_DEPTH — how many trusted proxies append to
 * X-Forwarded-For in front of the app (Vercel alone = 1; the rightmost hop is the client).
 *
 * It used to be parsed in three places as `Math.max(0, Number(raw ?? 1))`, which let
 * "abc" (NaN), "" and "-1" (0) skip the X-Forwarded-For peel and "1.5" index past it. The
 * copies then failed in different directions: get-client-ip trusted the caller's x-real-ip,
 * the middleware limiter put every client in one "unknown" bucket, and the blocklist went
 * silently off.
 *
 *   unset / blank            -> 1 (the default)
 *   integer 0..MAX (trimmed) -> that integer ("01" is 1)
 *   anything else            -> 1, with one console.error per distinct value
 *
 * MAX caps absurd values: a depth larger than the real hop count makes the peel land on (or
 * clamp to) a left-hand entry the CALLER wrote. A small wrong depth is still a
 * misconfiguration — the depth must equal the real number of proxies.
 *
 * No imports: middleware.ts runs on the Edge runtime.
 */
export const DEFAULT_TRUSTED_PROXY_DEPTH = 1;
export const MAX_TRUSTED_PROXY_DEPTH = 8;

const reported = new Set<string>();

export function trustedProxyDepth(raw: string | undefined = process.env.TRUSTED_PROXY_DEPTH): number {
  const v = raw?.trim() ?? "";
  if (v === "") return DEFAULT_TRUSTED_PROXY_DEPTH;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n <= MAX_TRUSTED_PROXY_DEPTH) return n;
  }
  if (!reported.has(v)) {
    reported.add(v);
    console.error(
      `[trusted-proxy-depth] TRUSTED_PROXY_DEPTH=${JSON.stringify(raw)} is not an integer 0..${MAX_TRUSTED_PROXY_DEPTH}; ` +
        `using ${DEFAULT_TRUSTED_PROXY_DEPTH}.`,
    );
  }
  return DEFAULT_TRUSTED_PROXY_DEPTH;
}
