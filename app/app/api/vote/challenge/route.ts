import { json } from "@/lib/allocation-vote/respond";
import { VOTE_UNAVAILABLE } from "@/lib/allocation-vote/state";
import { logDbError, voteDb } from "@/lib/allocation-vote/vote-db";
import { buildVoteMessage, VOTE_NONCE_RE, VOTE_POLL_KEY, VOTE_TS_RE } from "@/lib/allocation-vote/vote-message";
import { parseChallenge } from "@/lib/allocation-vote/vote-request";
import { isCtx, originGuard, rateLimited, readJsonBody, voteContext } from "@/lib/allocation-vote/vote-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST {"wallet","choice"} -> a single-use, 5-minute challenge for that
 * wallet and choice, plus the exact message to sign. Only while the poll is
 * open and only for wallets eligible in the poll's snapshot.
 */
export async function POST(req: Request) {
  const ctx = voteContext(req);
  if (!isCtx(ctx)) return ctx;
  const cross = originGuard(req);
  if (cross) return cross;
  const text = await readJsonBody(req);
  if (typeof text !== "string") return text;
  const p = parseChallenge(text);
  if (!p.ok) return json(p.status, { status: "invalid", error: p.error });

  let row;
  try {
    row = await voteDb.issueNonce(ctx.cfg, p.wallet, p.choice, ctx.key);
  } catch (e) {
    logDbError("challenge", e);
    return json(503, VOTE_UNAVAILABLE);
  }
  switch (row?.outcome) {
    case "ok": {
      const { nonce, issued_at: issuedAt, expires_at: expiresAt } = row;
      if (row.poll_key !== VOTE_POLL_KEY || !nonce || !VOTE_NONCE_RE.test(nonce) || !issuedAt || !VOTE_TS_RE.test(issuedAt) || !expiresAt || !VOTE_TS_RE.test(expiresAt)) {
        return json(503, VOTE_UNAVAILABLE);
      }
      const message = buildVoteMessage({ choice: p.choice, wallet: p.wallet, nonce, issuedAt, expiresAt });
      // The database built the same text independently; any drift fails closed.
      if (row.message !== message) return json(503, VOTE_UNAVAILABLE);
      return json(200, { status: "ok", poll: VOTE_POLL_KEY, wallet: p.wallet, choice: p.choice, nonce, issuedAt, expiresAt, message });
    }
    case "rate_limited":
      return rateLimited(row.retry_after_seconds);
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
