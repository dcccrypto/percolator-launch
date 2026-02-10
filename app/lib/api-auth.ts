import { NextRequest, NextResponse } from "next/server";

/**
 * Simple API key auth for internal/indexer routes.
 * Checks `x-api-key` header against INDEXER_API_KEY env var.
 * If INDEXER_API_KEY is not set, all requests are allowed (dev mode).
 */
/**
 * Simple API key auth for internal/indexer routes.
 * Returns true if authorized, false if not.
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
  return providedKey === expectedKey;
}

export const UNAUTHORIZED = NextResponse.json(
  { error: "Unauthorized — missing or invalid x-api-key header" },
  { status: 401 },
);
