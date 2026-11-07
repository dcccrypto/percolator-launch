import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";

/** No vote has started, so there is nothing final to publish. */
export function GET(req: Request) {
  return hostGuard(req) ?? json(409, { status: "not_started", final: false });
}
