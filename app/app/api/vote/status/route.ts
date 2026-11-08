import { json } from "@/lib/allocation-vote/respond";
import { VOTE_UNAVAILABLE } from "@/lib/allocation-vote/state";
import { logDbError, voteDb } from "@/lib/allocation-vote/vote-db";
import { VOTE_CHOICES, VOTE_POLL_KEY } from "@/lib/allocation-vote/vote-message";
import { isCtx, rateLimited, voteContext } from "@/lib/allocation-vote/vote-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATES = new Set(["not_started", "open", "closed"]);

/** Public poll state from the database clock. No per-wallet data. */
export async function GET(req: Request) {
  const ctx = voteContext(req);
  if (!isCtx(ctx)) return ctx;
  let row;
  try {
    row = await voteDb.status(ctx.cfg, ctx.key);
  } catch (e) {
    logDbError("status", e);
    return json(503, VOTE_UNAVAILABLE);
  }
  if (row?.outcome === "rate_limited") return rateLimited(row.retry_after_seconds);
  if (row?.outcome !== "ok" || !row.state || !STATES.has(row.state) || row.poll_key !== VOTE_POLL_KEY) {
    return json(503, VOTE_UNAVAILABLE);
  }
  return json(200, {
    status: "ok",
    state: row.state,
    poll: VOTE_POLL_KEY,
    choices: VOTE_CHOICES,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    server_now: row.server_now,
  });
}
