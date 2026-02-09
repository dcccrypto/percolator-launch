import { NextRequest, NextResponse } from "next/server";

/**
 * Simple API key auth for internal/indexer routes.
 * Checks `x-api-key` header against INDEXER_API_KEY env var.
 * If INDEXER_API_KEY is not set, all requests are allowed (dev mode).
 */
export function requireAuth(req: NextRequest): boolean {
  const expectedKey = process.env.INDEXER_API_KEY;
  if (!expectedKey) return true; // No key configured = open (dev mode)
  const providedKey = req.headers.get("x-api-key");
  return providedKey === expectedKey;
}

export const UNAUTHORIZED = NextResponse.json(
  { error: "Unauthorized — missing or invalid x-api-key header" },
  { status: 401 }
);
