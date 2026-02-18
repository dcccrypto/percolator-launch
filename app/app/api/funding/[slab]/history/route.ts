import { NextResponse } from "next/server";

/**
 * GET /api/funding/[slab]/history
 *
 * Stub — returns empty history to prevent 404s.
 */
export async function GET() {
  return NextResponse.json({ history: [] });
}
