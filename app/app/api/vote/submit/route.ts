import { VOTE_UNAVAILABLE_MESSAGE } from "@/lib/allocation-vote/state";
import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";

/** Fails closed: the vote is disabled, so the request body is never read. */
export function POST(req: Request) {
  return hostGuard(req) ?? json(503, { status: "unavailable", message: VOTE_UNAVAILABLE_MESSAGE });
}
