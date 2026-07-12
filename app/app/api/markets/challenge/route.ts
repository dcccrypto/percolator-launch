import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import { createPlaygroundChallenge } from "@/lib/playground-nonce-store";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { getClientIp } from "@/lib/get-client-ip";

export const dynamic = "force-dynamic";

// SEC: per-IP rate limit. This endpoint was unauthenticated and unlimited,
// and each call does a Blob read-modify-write on the shared nonce store. An
// attacker could (a) spam a VICTIM's deployer pubkey (public, on-chain) to
// fill its 10 pending-challenge slots and lock the victim out of registering
// for the 5-min TTL, or (b) flood random deployers to thrash/evict the global
// store so legit nonces expire before they're claimed. A per-IP cap bounds a
// single-IP attacker below the per-deployer slot count, so they can't fill a
// victim's slots or churn the store from one address. 5/min keeps a single IP
// at half the 10-slot per-deployer cap within any 60s window (a human launch
// needs 1-2), so it can't fill a victim's slots in one burst — matching the
// sibling create-market limiter. Same shared Upstash limiter as /api/rpc, with
// the in-memory fallback for dev/CI. Tunable via env.
const CHALLENGE_RATE_LIMIT_MAX = Number(
  process.env.MARKETS_CHALLENGE_RATE_LIMIT_PER_WINDOW ?? "5",
); // per IP / 60s
const challengeRateLimiter = createUpstashRateLimiter({
  limit: CHALLENGE_RATE_LIMIT_MAX,
  windowMs: 60_000,
  prefix: "rl:markets-challenge",
});

/**
 * PERC-8332: Nonce challenge endpoint for deployer wallet-sig verification.
 *
 * Flow:
 *   1. Deployer calls GET /api/markets/challenge?deployer=<pubkey>
 *   2. Server stores a UUID nonce (Vercel Blob-backed — lib/playground-nonce-store.ts)
 *   3. Deployer signs the nonce bytes with their ed25519 keypair
 *   4. POST /api/markets includes { nonce, signature } for verification
 *
 * Store: lib/playground-nonce-store.ts, a small Vercel Blob JSON store (same pattern
 * as lib/playground-registered-markets.ts) — durable across serverless invocations,
 * so the GET that issues a nonce here and the POST that later claims it can land on
 * different Vercel lambda instances without losing it. (This used to be a process-
 * local Map, which broke exactly that way in production — see the store's header.)
 *
 * Production: same endpoint; the POST handler validates via nacl + the same store.
 * (The market_challenges Supabase table is no longer used — this store is
 * sufficient for the playground use case and avoids the cold-start 500.)
 */
export async function GET(req: NextRequest) {
  try {
    // Rate-limit before the deployer param is even read — the expensive part
    // (and the abuse target) is createPlaygroundChallenge's Blob write below.
    if (Number.isFinite(CHALLENGE_RATE_LIMIT_MAX) && CHALLENGE_RATE_LIMIT_MAX > 0) {
      const rl = await challengeRateLimiter.check(getClientIp(req));
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Too many challenge requests — try again shortly." },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSecs) } },
        );
      }
    }

    const deployer = req.nextUrl.searchParams.get("deployer");

    if (!deployer) {
      return NextResponse.json(
        { error: "Missing required param: deployer" },
        { status: 400 },
      );
    }

    // Validate deployer is a valid Solana pubkey
    try {
      new PublicKey(deployer);
    } catch {
      return NextResponse.json(
        { error: "Invalid deployer: must be a valid Solana public key" },
        { status: 400 },
      );
    }

    const result = await createPlaygroundChallenge(deployer);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const { nonce, expiresAt } = result;

    return NextResponse.json(
      {
        nonce,
        deployer,
        expiresAt: expiresAt.toISOString(),
        message: `Sign the nonce bytes (UTF-8 encoded) with your deployer keypair to authenticate market registration.`,
        instructions: {
          step1: "Encode the nonce as UTF-8 bytes",
          step2: "Sign the bytes with ed25519 using the deployer keypair (wallet.signMessage)",
          step3: "Include nonce and base64-encoded signature in POST /api/markets body",
        },
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets/challenge", method: "GET" },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
