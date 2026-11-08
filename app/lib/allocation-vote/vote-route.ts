/**
 * Shared plumbing for the /api/vote/* handlers: host lock, server-only DB
 * config, rate-limit client key, strict JSON envelope, and Origin check.
 */
import "server-only";
import type { NextResponse } from "next/server";
import { checkEnvelope } from "./check-request";
import { clientKey } from "./client-key";
import { isAllocationVoteHost } from "./host";
import { hostGuard, json } from "./respond";
import { readAllocationConfig, type AllocationConfig } from "./server-config";
import { VOTE_UNAVAILABLE } from "./state";
import { readCapped, VOTE_MAX_BODY } from "./vote-request";

export type VoteCtx = { cfg: AllocationConfig; key: Buffer };

/** Host lock + DB config; a Response when the request must stop here. */
export function voteContext(req: Request): VoteCtx | NextResponse {
  const blocked = hostGuard(req);
  if (blocked) return blocked;
  const cfg = readAllocationConfig();
  if (!cfg) return json(503, VOTE_UNAVAILABLE);
  return { cfg, key: clientKey(req.headers, cfg.secret) };
}

export const isCtx = (x: VoteCtx | NextResponse): x is VoteCtx => !!x && typeof x === "object" && "cfg" in x && "key" in x;

/**
 * Same-origin POST only: a browser Origin, when sent, must name exactly the
 * (already host-locked) request Host. Non-browser clients send no Origin.
 */
export function originGuard(req: Request): NextResponse | null {
  const o = req.headers.get("origin");
  if (o === null) return null;
  let host = "";
  try {
    const u = new URL(o);
    if ((u.protocol === "https:" || u.protocol === "http:") && u.origin === o) host = u.host;
  } catch {
    host = "";
  }
  const reqHost = (req.headers.get("host") ?? "").toLowerCase();
  if (!host || !isAllocationVoteHost(host) || host !== reqHost) {
    return json(403, { status: "forbidden", error: "Cross-site request refused" });
  }
  return null;
}

/** Content-Type + size envelope, then the capped body text. */
export async function readJsonBody(req: Request): Promise<string | NextResponse> {
  const refused = checkEnvelope(req.headers.get("content-type"), req.headers.get("content-length"));
  if (refused) return json(refused.status, { status: "invalid", error: refused.error });
  const text = await readCapped(req, VOTE_MAX_BODY);
  if (text === null) return json(413, { status: "invalid", error: "Request too large" });
  return text;
}

export function rateLimited(retry: number): NextResponse {
  const s = Math.max(1, Math.min(24 * 3600, Math.floor(retry) || 1));
  const res = json(429, { status: "rate_limited", retry_after_seconds: s });
  res.headers.set("Retry-After", String(s));
  return res;
}
