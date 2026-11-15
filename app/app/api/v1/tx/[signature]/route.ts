/**
 * GET /api/v1/tx/{signature}?lastValidBlockHeight=&messageHash=: pending / processed / confirmed / finalized / failed / expired / unknown.
 * Also ends a reduce-only reservation (lib/bot-api/reduce-reservations.ts) the transaction held: when it landed (the order's
 * message hash is read from the landed transaction), or with ?messageHash= once the chain is past that build's lastValidBlockHeight.
 */
import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { txStatus } from "@/lib/bot-api/builders/status";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute<{ signature: string }>({ route: "/v1/tx/{signature}", scope: "read", weight: 1 }, async ({ req, params, meta }) => {
  const q = req.nextUrl.searchParams.get("lastValidBlockHeight");
  let lvbh: number | null = null;
  if (q !== null) {
    if (!/^\d{1,15}$/.test(q)) throw new ApiError("bad_request", "lastValidBlockHeight must be a non-negative integer");
    lvbh = Number(q);
  }
  const mh = req.nextUrl.searchParams.get("messageHash");
  if (mh !== null && !/^[0-9a-f]{64}$/.test(mh)) throw new ApiError("bad_request", "messageHash must be the 64-hex messageHash of the returned transaction");
  return { body: await txStatus(getBotConnection("confirmed"), params.signature, lvbh, meta, { messageHash: mh }) };
});
