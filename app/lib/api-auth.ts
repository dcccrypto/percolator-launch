import { timingSafeEqual, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Simple API key auth for internal/indexer routes.
 * Checks `x-api-key` header against INDEXER_API_KEY env var.
 * Uses timing-safe comparison (PERC-597) to prevent timing-oracle attacks.
 * R2-S9: In production without a configured key, rejects all requests.
 */
export function requireAuth(req: NextRequest): boolean {
  const expectedKey = process.env.INDEXER_API_KEY;
  if (!expectedKey) {
    // R2-S9: In production, reject all requests if auth key is not configured
    if (process.env.NODE_ENV === "production") return false;
    return true; // No key configured = open (dev mode only)
  }
  const providedKey = req.headers.get("x-api-key");
  if (!providedKey) return false;

  // Hash both values to guarantee equal buffer length for timingSafeEqual.
  // This avoids leaking key length via an early-return on length mismatch.
  const expectedHash = createHash("sha256").update(expectedKey).digest();
  const providedHash = createHash("sha256").update(providedKey).digest();
  try {
    return timingSafeEqual(expectedHash, providedHash);
  } catch {
    return false;
  }
}

export const UNAUTHORIZED = NextResponse.json(
  { error: "Unauthorized — missing or invalid x-api-key header" },
  { status: 401 },
);
