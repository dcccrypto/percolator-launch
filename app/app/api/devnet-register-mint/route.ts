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
import { getClientIp } from "@/lib/get-client-ip";

export const dynamic = "force-dynamic";

const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const current = requestCounts.get(ip);

  if (!current || now > current.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (current.count >= RATE_LIMIT_MAX) return true;
  current.count++;
  return false;
}

function isPrintableName(value: string): boolean {
  return /^[\w\s._-]{1,64}$/.test(value);
}

function isTicker(value: string): boolean {
  return /^[A-Z0-9._-]{1,12}$/.test(value);
}

export async function POST(req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }

  try {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Rate limited - max 20 register-mint requests per hour" },
        { status: 429 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

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

    const safeName = name?.trim() || `Token ${mintAddress.slice(0, 6)}`;
    if (!isPrintableName(safeName)) {
      return NextResponse.json(
        { error: "Invalid name (1-64 chars; letters, numbers, space, ._- only)" },
        { status: 400 },
      );
    }

    const rawSymbol = symbol?.trim().toUpperCase() || mintAddress.slice(0, 4).toUpperCase();
    if (!isTicker(rawSymbol)) {
      return NextResponse.json(
        { error: "Invalid symbol (1-12 chars; A-Z, 0-9, ._- only)" },
        { status: 400 },
      );
    }

    const safeDecimals = decimals ?? 6;
    if (!Number.isInteger(safeDecimals) || safeDecimals < 0 || safeDecimals > 18) {
      return NextResponse.json({ error: "Invalid decimals (must be integer 0-18)" }, { status: 400 });
    }

    // Best-effort DB upsert — guarded when Supabase unavailable
    try {
      const supabase = getServiceClient();
      const { error } = await supabase.from("devnet_mints").upsert(
        {
          mainnet_ca: mintAddress,
          devnet_mint: mintAddress,
          name: safeName,
          symbol: rawSymbol,
          decimals: safeDecimals,
        },
        { onConflict: "mainnet_ca", ignoreDuplicates: true },
      );
      if (error) throw error;
    } catch (dbErr) {
      // If Supabase unavailable, return success anyway — endpoint is best-effort
      console.warn("[devnet-register-mint] DB upsert failed (non-fatal):", dbErr instanceof Error ? dbErr.message : String(dbErr));
    }

    return NextResponse.json({ status: "registered", mintAddress });
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "/api/devnet-register-mint" } });
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
