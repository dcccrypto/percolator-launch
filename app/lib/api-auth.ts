import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Simple API key auth for internal/indexer routes.
 * Checks `x-api-key` header against INDEXER_API_KEY env var.
 * Uses timing-safe comparison to prevent timing attacks (PERC-597).
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

  // PERC-597: timing-safe comparison to prevent timing side-channel attacks
  const expected = Buffer.from(expectedKey, "utf8");
  const provided = Buffer.from(providedKey, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export const UNAUTHORIZED = NextResponse.json(
  { error: "Unauthorized — missing or invalid x-api-key header" },
  { status: 401 },
);
