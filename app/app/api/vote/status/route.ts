import { VOTE_STATUS } from "@/lib/allocation-vote/state";
import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";

/** The vote is disabled: always UNAVAILABLE, never open. */
export function GET(req: Request) {
  return hostGuard(req) ?? json(200, VOTE_STATUS);
}
