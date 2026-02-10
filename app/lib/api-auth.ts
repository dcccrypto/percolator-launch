import { NextRequest, NextResponse } from "next/server";

/**
 * Simple API key auth for internal/indexer routes.
 * Checks `x-api-key` header against INDEXER_API_KEY env var.
 * If INDEXER_API_KEY is not set, all requests are allowed (dev mode).
 */
/** Returns true if authorized, false if not, or a Response for server errors */
export function requireAuth(req: NextRequest): boolean | NextResponse {
  const expectedKey = process.env.INDEXER_API_KEY;
  if (!expectedKey) {
    // R2-S9: In production, reject all requests if auth key is not configured
    if (process.env.NODE_ENV === "production") {
      return SERVER_MISCONFIGURED;
    }
    return true; // No key configured = open (dev mode only)
  }
  const providedKey = req.headers.get("x-api-key");
  return providedKey === expectedKey;
}

export const UNAUTHORIZED = NextResponse.json(
  { error: "Unauthorized — missing or invalid x-api-key header" },
  { status: 401 },
);

export const SERVER_MISCONFIGURED = NextResponse.json(
  { error: "Server misconfigured — auth key not set" },
  { status: 500 },
);
