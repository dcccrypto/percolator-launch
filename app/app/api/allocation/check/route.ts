import { validateOwner } from "@/lib/allocation-vote/owner";
import { ALLOCATION_UNAVAILABLE_MESSAGE } from "@/lib/allocation-vote/state";
import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";

const MAX_BODY = 1024;

/**
 * Port of the local checker's POST /api/check with no data loaded: a malformed
 * address gets the same 400 message, a well-formed one gets 503 unavailable.
 * No address is logged or stored, and no allocation figure exists to return.
 */
export async function POST(req: Request) {
  const blocked = hostGuard(req);
  if (blocked) return blocked;
  if (!String(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return json(415, { status: "invalid", error: "Content-Type must be application/json" });
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return json(413, { status: "invalid", error: "Request too large" });
  const text = await req.text();
  if (text.length > MAX_BODY) return json(413, { status: "invalid", error: "Request too large" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { status: "invalid", error: 'Body must be JSON {"wallet": "<address>"}' });
  }
  const wallet = parsed && typeof parsed === "object" ? (parsed as { wallet?: unknown }).wallet : undefined;
  const v = validateOwner(wallet);
  if (!v.ok) return json(400, { status: "invalid", error: v.message });
  return json(503, { status: "unavailable", message: ALLOCATION_UNAVAILABLE_MESSAGE });
}
