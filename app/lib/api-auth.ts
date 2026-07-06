import { timingSafeEqual, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Simple API key auth for internal/indexer routes.
 * Checks `x-api-key` header against INDEXER_API_KEY env var.
 * Uses timing-safe comparison (PERC-597) to prevent timing-oracle attacks.
 * Fail-closed: when INDEXER_API_KEY is not configured, all requests are
 * rejected in every environment. Staging/preview deployments are not
 * "production" but serve real data, so NODE_ENV cannot gate this check.
 * Set any non-empty INDEXER_API_KEY value for local development.
 */
export function requireAuth(req: NextRequest): boolean {
  const expectedKey = process.env.INDEXER_API_KEY?.trim() || undefined;
  if (!expectedKey) return false;
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
