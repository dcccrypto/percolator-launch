import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getClientIp } from "@/lib/get-client-ip";
import { verifyPrivyAuth } from "@/lib/privy-auth";
import { checkKeeperCapacityRateLimit } from "@/lib/keeper-capacity-rate-limit";
import { enrollmentCapsFromEnv, readCreatorAtLimit } from "@/lib/keeper-enrollment-guard";

/**
 * GET /api/playground/keeper-capacity?wallet=<base58>  (#3320)
 *
 * Is the CALLER's own wallet at the per-creator live-price ceiling? Asked before a launch spends
 * anything, so the wizard can say so instead of building a market keeper-register will refuse.
 *
 *   200 { atLimit: boolean }    and nothing else: no count, no list of markets, no cap value
 *   400 bad wallet · 401 no / invalid Privy session · 403 wallet is not linked to that session
 *   429 rate limited · 503 unavailable (callers treat every non-200 as "unknown" and do not block)
 *
 * WALLET BINDING (no new prompt, no new scheme): the same Privy session check the admin routes use
 * (lib/privy-auth.ts verifyPrivyAuth). The browser sends its Privy access token and identity token;
 * the server verifies both (signature + same subject) and takes the Solana wallets linked to that
 * Privy user from the verified identity token. `wallet` is only a selector: it is answered iff it
 * is one of those verified wallets. Any other wallet is refused and the database is never queried
 * for it, so this cannot be used to read another creator's enrollment (the reason the unauthenticated
 * #3325 shape was refused). A browser using a plain wallet adapter has no Privy session; it gets
 * 401 and the wizard behaves as before.
 *
 * The verdict is computed by lib/keeper-enrollment-guard.ts readCreatorAtLimit, which counts through
 * the same filter and cap as keeper-register's checkEnrollmentCaps.
 *
 * The global ceiling is deliberately absent: a full deployment is a state that clears (keeper-register
 * answers it 429 and the launch retries), not a per-wallet limit, so it never blocks and is never
 * reported as one.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const UNAVAILABLE = "Unavailable right now.";

export async function GET(request: NextRequest) {
  const rl = await checkKeeperCapacityRateLimit(getClientIp(request));
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.max(1, rl.retryAfter)) } },
    );
  }

  let wallet: string;
  try {
    wallet = new PublicKey(new URL(request.url).searchParams.get("wallet") ?? "").toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400, headers: NO_STORE });
  }

  const auth = await verifyPrivyAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Sign in required" }, { status: auth.status, headers: NO_STORE });
  }
  // Same answer for "not yours" whatever the wallet: nothing about it is looked up.
  if (!auth.solanaWallets.includes(wallet)) {
    return NextResponse.json({ error: "Wallet is not linked to this session" }, { status: 403, headers: NO_STORE });
  }

  try {
    const { getServiceClient, getServerNetwork } = await import("@/lib/supabase");
    const read = await readCreatorAtLimit(
      getServiceClient(),
      { deployer: wallet, network: getServerNetwork() },
      enrollmentCapsFromEnv(),
    );
    if (!read.ok) return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers: NO_STORE });
    return NextResponse.json({ atLimit: read.atLimit }, { headers: NO_STORE });
  } catch {
    // Supabase not configured, or the client threw: never echo the reason.
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers: NO_STORE });
  }
}
