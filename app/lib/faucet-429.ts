/**
 * A 429 from a free-asset route is one of two things. The per-wallet daily claim gate sends a
 * `nextClaimAt` (/api/faucet, /api/devnet-airdrop). The shared per-IP fund limit (10 a minute,
 * lib/fund-ip-rate-limit.ts) and the middleware limit send `Retry-After` and no `nextClaimAt`: they
 * are short and say nothing about whether this wallet already claimed. components/create/LaunchSuccess
 * tells them apart the same way. One edge: /api/faucet's gate fails closed with `nextClaimAt: null`
 * when its database check errors (lib/faucet-rate-gate.ts); the wallet has not claimed then, so the
 * short "try again" reads truer than "already claimed".
 *
 * Returns the message for the short limit, or null when the 429 is the daily claim gate.
 */
export function shortRateLimitMessage(resp: Response, body: { nextClaimAt?: unknown } | null | undefined): string | null {
  if (resp.status !== 429 || typeof body?.nextClaimAt === "string") return null;
  const wait = Number(resp.headers.get("Retry-After"));
  return Number.isFinite(wait) && wait > 0
    ? `Too many requests. Try again in ${Math.ceil(wait)}s.`
    : "Too many requests. Try again in a minute.";
}
