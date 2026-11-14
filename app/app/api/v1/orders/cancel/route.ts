/**
 * POST /api/v1/orders/cancel { idempotencyKey }: v2.2 has no resting orders, so nothing on chain is cancelled. This
 * stops the API from handing that build's bytes out again (a replay of the key gets 409 order_cancelled) and returns its
 * lastValidBlockHeight: bytes the caller already holds can still land until the chain passes that height, never after.
 * Poll GET /api/v1/tx/{signature}?lastValidBlockHeight= to see "expired".
 */
import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { cancelIdempotent, validIdempotencyKey } from "@/lib/bot-api/idempotency";
import { onlyKeys } from "@/lib/bot-api/builders/common";

export const dynamic = "force-dynamic";

export const POST = botRoute({ route: "/v1/orders/cancel", scope: "build", weight: 1, body: true }, async ({ body, principal }) => {
  onlyKeys(body, ["idempotencyKey"]);
  const k = body.idempotencyKey;
  if (typeof k !== "string" || !validIdempotencyKey(k)) throw new ApiError("bad_request", "idempotencyKey must be the Idempotency-Key the build was sent with");
  const r = await cancelIdempotent(principal.id, k);
  if (!r.found) throw new ApiError("not_found", "no build with this Idempotency-Key in the last 120 s");
  if (r.inProgress) throw new ApiError("idempotency_in_progress", "the build for this Idempotency-Key is still running; cancel again when it has answered", { headers: { "Retry-After": "1" } });
  return {
    body: {
      idempotencyKey: k,
      cancelled: true,
      alreadyCancelled: r.alreadyCancelled,
      lastValidBlockHeight: r.lastValidBlockHeight,
      onchain: "none: v2.2 has no resting orders; unsent bytes expire at lastValidBlockHeight",
    },
  };
});
