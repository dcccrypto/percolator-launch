import { json } from "@/lib/allocation-vote/respond";
import { VOTE_UNAVAILABLE } from "@/lib/allocation-vote/state";
import { logDbError, voteDb } from "@/lib/allocation-vote/vote-db";
import { VOTE_POLL_KEY } from "@/lib/allocation-vote/vote-message";
import { isCtx, rateLimited, voteContext } from "@/lib/allocation-vote/vote-route";
import { decideWinner, formatUnits, sharePercent } from "@/lib/allocation-vote/vote-tally";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RAW = /^(0|[1-9]\d{0,39})$/;

/**
 * Aggregate result only, and only once the 24h window has closed (by database
 * time). Balance weighted, no quorum; a tie or zero votes is buy-and-burn.
 * The winner from the database is cross-checked against the same rule here.
 */
export async function GET(req: Request) {
  const ctx = voteContext(req);
  if (!isCtx(ctx)) return ctx;
  let t;
  try {
    t = await voteDb.tally(ctx.cfg, ctx.key);
  } catch (e) {
    logDbError("results", e);
    return json(503, VOTE_UNAVAILABLE);
  }
  if (t?.outcome === "rate_limited") return rateLimited(t.retry_after_seconds);
  if (t?.outcome !== "ok" || t.poll_key !== VOTE_POLL_KEY) return json(503, VOTE_UNAVAILABLE);
  if (t.state === "not_started" || t.state === "open" || t.state === "tallying") {
    return json(409, { status: t.state, final: false, ends_at: t.ends_at });
  }
  if (
    t.state !== "closed" || !RAW.test(t.weekly_fee_claims_raw ?? "") || !RAW.test(t.buy_and_burn_raw ?? "") ||
    !RAW.test(t.eligible_raw_total ?? "") || typeof t.token_decimals !== "number"
  ) {
    return json(503, VOTE_UNAVAILABLE);
  }
  const fee = BigInt(t.weekly_fee_claims_raw!);
  const burn = BigInt(t.buy_and_burn_raw!);
  const total = BigInt(t.eligible_raw_total!);
  const winner = decideWinner(fee, burn);
  if (winner !== t.winner) return json(503, VOTE_UNAVAILABLE);
  const d = t.token_decimals;
  const voted = fee + burn;
  return json(200, {
    status: "final",
    final: true,
    poll: VOTE_POLL_KEY,
    ends_at: t.ends_at,
    winner,
    rule: "Balance-weighted majority of votes cast, no quorum. A tie or zero votes is buy-and-burn.",
    results: {
      "weekly-fee-claims": { balance: formatUnits(fee, d), wallets: t.weekly_fee_claims_wallets, share_of_votes_percent: sharePercent(fee, voted) },
      "buy-and-burn": { balance: formatUnits(burn, d), wallets: t.buy_and_burn_wallets, share_of_votes_percent: sharePercent(burn, voted) },
    },
    turnout: { voted_balance: formatUnits(voted, d), eligible_balance: formatUnits(total, d), eligible_wallets: t.eligible_wallets, percent: sharePercent(voted, total) },
  });
}
