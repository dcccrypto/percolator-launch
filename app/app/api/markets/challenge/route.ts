import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import { createPlaygroundChallenge } from "@/lib/playground-nonce-store";

export const dynamic = "force-dynamic";

/**
 * PERC-8332: Nonce challenge endpoint for deployer wallet-sig verification.
 *
 * Flow:
 *   1. Deployer calls GET /api/markets/challenge?deployer=<pubkey>
 *   2. Server stores a UUID nonce (process-local Map — no Supabase required locally)
 *   3. Deployer signs the nonce bytes with their ed25519 keypair
 *   4. POST /api/markets includes { nonce, signature } for verification
 *
 * Playground (local dev): uses a process-local Map (lib/playground-nonce-store.ts)
 * so the endpoint works without a Supabase connection.
 *
 * Production: same endpoint; the POST handler validates via nacl + the same store.
 * (The market_challenges Supabase table is no longer used — the in-process store
 * is sufficient for the playground use case and avoids the cold-start 500.)
 */
export async function GET(req: NextRequest) {
  try {
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

    const result = createPlaygroundChallenge(deployer);

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
