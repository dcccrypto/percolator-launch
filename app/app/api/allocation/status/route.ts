import { ALLOCATION_STATUS } from "@/lib/allocation-vote/state";
import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";

/** Allocations are not published: always reports unavailable. */
export function GET(req: Request) {
  return hostGuard(req) ?? json(200, ALLOCATION_STATUS);
}
