/**
 * POST /api/devnet-register-mint
 *
 * Registers an existing devnet SPL mint in the devnet_mints table so
 * the devnet-airdrop endpoint can find it. Used when a user pastes a
 * devnet-native mint address (not a mainnet mirror).
 *
 * Body: { mintAddress: string, name?: string, symbol?: string, decimals?: number }
 *
 * Only callable on devnet. Best-effort — failures are non-fatal.
 */

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() ?? "mainnet";

export async function POST(req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { mintAddress, name, symbol, decimals } = body as {
      mintAddress?: string;
      name?: string;
      symbol?: string;
      decimals?: number;
    };

    if (!mintAddress) {
      return NextResponse.json({ error: "Missing mintAddress" }, { status: 400 });
    }

    try {
      new PublicKey(mintAddress);
    } catch {
      return NextResponse.json({ error: "Invalid mintAddress" }, { status: 400 });
    }

    const supabase = getServiceClient();

    // Upsert: use mintAddress as both mainnet_ca and devnet_mint for native devnet mints.
    // This allows devnet-airdrop to look up by devnet_mint and find the row.
    await (supabase as any).from("devnet_mints").upsert(
      {
        mainnet_ca: mintAddress, // self-referencing for devnet-native mints
        devnet_mint: mintAddress,
        name: name ?? `Token ${mintAddress.slice(0, 6)}`,
        symbol: symbol ?? mintAddress.slice(0, 4).toUpperCase(),
        decimals: decimals ?? 6,
      },
      { onConflict: "mainnet_ca", ignoreDuplicates: true },
    );

    return NextResponse.json({ status: "registered", mintAddress });
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "/api/devnet-register-mint" } });
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
