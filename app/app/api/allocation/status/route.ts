import { readAllocationConfig } from "@/lib/allocation-vote/server-config";
import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Whether the checker is configured. Figures are always provisional. No database call. */
export function GET(req: Request) {
  const blocked = hostGuard(req);
  if (blocked) return blocked;
  return readAllocationConfig()
    ? json(200, { published: true, data: "provisional" })
    : json(200, { published: false, data: "unavailable" });
}
