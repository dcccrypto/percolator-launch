import { json, notFound } from "@/lib/allocation-vote/respond";
import { VOTE_UNAVAILABLE } from "@/lib/allocation-vote/state";
import { isAdminAuthorized, readVoteAdminSecret } from "@/lib/allocation-vote/vote-admin";
import { logDbError, voteDb } from "@/lib/allocation-vote/vote-db";
import { START_CONFIRMATION, VOTE_POLL_KEY } from "@/lib/allocation-vote/vote-message";
import { isCtx, originGuard, rateLimited, readJsonBody, voteContext } from "@/lib/allocation-vote/vote-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One-click admin start: opens the 24h vote window ONCE (a started poll can
 * never be restarted, extended or edited).
 *
 *   POST, Authorization: Bearer <VOTE_ADMIN_SECRET>, body {"confirm":"START perc-fee-policy-2026-11"}
 *
 * Without VOTE_ADMIN_SECRET configured the endpoint does not exist (404).
 * Every attempt is rate limited in the database BEFORE the secret is compared.
 */
export async function POST(req: Request) {
  const ctx = voteContext(req);
  if (!isCtx(ctx)) return ctx;
  const secret = readVoteAdminSecret();
  if (!secret) return notFound();
  const cross = originGuard(req);
  if (cross) return cross;

  try {
    const retry = await voteDb.adminGate(ctx.cfg, ctx.key);
    if (retry > 0) return rateLimited(retry);
  } catch (e) {
    logDbError("admin gate", e);
    return json(503, VOTE_UNAVAILABLE);
  }
  if (!isAdminAuthorized(req.headers.get("authorization"), secret)) {
    return json(401, { status: "unauthorized", error: "Unauthorized" });
  }

  const text = await readJsonBody(req);
  if (typeof text !== "string") return text;
  let confirm: unknown;
  try {
    const o = JSON.parse(text) as unknown;
    confirm = o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 1 ? (o as { confirm?: unknown }).confirm : undefined;
  } catch {
    confirm = undefined;
  }
  if (confirm !== START_CONFIRMATION) {
    return json(400, { status: "invalid", error: `Body must be {"confirm":"${START_CONFIRMATION}"}` });
  }

  let row;
  try {
    row = await voteDb.start(ctx.cfg, VOTE_POLL_KEY);
  } catch (e) {
    logDbError("admin start", e);
    return json(503, VOTE_UNAVAILABLE);
  }
  switch (row?.outcome) {
    case "started":
      console.info("[vote] poll started");
      return json(200, { status: "started", poll: VOTE_POLL_KEY, starts_at: row.starts_at, ends_at: row.ends_at });
    case "already_started":
      return json(409, { status: "already_started", poll: VOTE_POLL_KEY, starts_at: row.starts_at, ends_at: row.ends_at });
    case "no_snapshot":
      return json(409, { status: "no_snapshot", error: "No active snapshot; the vote cannot start." });
    default:
      return json(503, VOTE_UNAVAILABLE);
  }
}
