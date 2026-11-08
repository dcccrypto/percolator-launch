import { json } from "@/lib/allocation-vote/respond";
import { VOTE_UNAVAILABLE } from "@/lib/allocation-vote/state";
import { logDbError, voteDb } from "@/lib/allocation-vote/vote-db";
import { buildVoteMessage, VOTE_TS_RE } from "@/lib/allocation-vote/vote-message";
import { parseSubmit } from "@/lib/allocation-vote/vote-request";
import { isCtx, originGuard, rateLimited, readJsonBody, voteContext } from "@/lib/allocation-vote/vote-route";
import { verifyVoteSignature } from "@/lib/allocation-vote/vote-verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RETRY = "Request a new signature and try again.";

/**
 * POST {"wallet","choice","nonce","issuedAt","expiresAt","signature"}.
 * The server rebuilds the canonical message from these fields, verifies the
 * wallet's Ed25519 signature over it, then the database (one transaction)
 * re-checks the message, the window, eligibility and the nonce, consumes the
 * nonce and records this wallet's single ballot. Last valid vote wins.
 */
export async function POST(req: Request) {
  const ctx = voteContext(req);
  if (!isCtx(ctx)) return ctx;
  const cross = originGuard(req);
  if (cross) return cross;
  const text = await readJsonBody(req);
  if (typeof text !== "string") return text;
  const p = parseSubmit(text);
  if (!p.ok) return json(p.status, { status: "invalid", error: p.error });

  try {
    const retry = await voteDb.submitGate(ctx.cfg, ctx.key);
    if (retry > 0) return rateLimited(retry);
  } catch (e) {
    logDbError("submit gate", e);
    return json(503, VOTE_UNAVAILABLE);
  }

  const message = buildVoteMessage(p);
  const signature = verifyVoteSignature(p.wallet, message, p.signature);
  if (!signature) return json(401, { status: "bad_signature", error: "Signature does not match this wallet and vote." });

  let row;
  try {
    row = await voteDb.cast(ctx.cfg, { ...p, message, signature }, ctx.key);
  } catch (e) {
    logDbError("submit", e);
    return json(503, VOTE_UNAVAILABLE);
  }
  switch (row?.outcome) {
    case "recorded":
      if (row.choice !== p.choice || !row.cast_at || !VOTE_TS_RE.test(row.cast_at)) return json(503, VOTE_UNAVAILABLE);
      return json(200, { status: "recorded", choice: row.choice, revision: row.revision, cast_at: row.cast_at, ends_at: row.ends_at });
    case "superseded":
      return json(409, { status: "superseded", error: "A later vote from this wallet is already recorded." });
    case "rate_limited":
      return rateLimited(row.retry_after_seconds);
    case "expired":
      return json(410, { status: "expired", error: `This signature request expired. ${RETRY}` });
    case "bad_nonce":
    case "message_mismatch":
      return json(400, { status: "bad_nonce", error: `This signature request is not valid or was already used. ${RETRY}` });
    case "not_started":
      return json(409, { status: "not_started", error: "Voting has not started." });
    case "closed":
      return json(409, { status: "closed", error: "Voting has closed." });
    case "not_eligible":
      return json(403, { status: "not_eligible", error: "This wallet is not eligible in the 7 Nov 2026 snapshot." });
    case "invalid":
      return json(400, { status: "invalid", error: "Invalid request" });
    default:
      return json(503, VOTE_UNAVAILABLE);
  }
}
