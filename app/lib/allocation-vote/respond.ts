/**
 * Response helpers shared by the /api/allocation/* and /api/vote/* handlers.
 * Every response is noindex + no-store; any host other than percolator.trade
 * gets the same 404 the middleware returns (defense in depth).
 */
import { NextResponse } from "next/server";
import { NOINDEX, isAllocationVoteHost } from "./host";

const HEADERS = {
  "X-Robots-Tag": NOINDEX,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

export function notFound(): NextResponse {
  return new NextResponse("Not Found", { status: 404, headers: { ...HEADERS, "Content-Type": "text/plain" } });
}

/** null when the request may proceed, otherwise the 404 to return. */
export function hostGuard(req: Request): NextResponse | null {
  return isAllocationVoteHost(req.headers.get("host")) ? null : notFound();
}
