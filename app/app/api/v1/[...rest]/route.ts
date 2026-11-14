/**
 * Catch-all for /api/v1/*: a path that is not an endpoint answers the JSON `not_found` envelope (not Next's HTML 404), for
 * every method. Specific routes always win over this one. When the API is off it answers `disabled`, like every other route.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/bot-api/errors";
import { botApiDisabledReason } from "@/lib/bot-api/config";

export const dynamic = "force-dynamic";

function notFound(_req: NextRequest): NextResponse {
  const off = botApiDisabledReason();
  const err = off ? new ApiError("disabled", off) : new ApiError("not_found", "no such endpoint; GET /api/v1/openapi.json lists them");
  return NextResponse.json(err.body(), { status: err.status, headers: { "Cache-Control": "no-store", "X-Request-Id": randomUUID() } });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
