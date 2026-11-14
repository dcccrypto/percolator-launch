/** GET /api/v1/tx/{signature}?lastValidBlockHeight=: pending / processed / confirmed / finalized / failed / expired / unknown. */
import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { txStatus } from "@/lib/bot-api/builders/status";

export const dynamic = "force-dynamic";

export const GET = botRoute<{ signature: string }>({ route: "/v1/tx/{signature}", scope: "read", weight: 1 }, async ({ req, params, meta }) => {
  const q = req.nextUrl.searchParams.get("lastValidBlockHeight");
  let lvbh: number | null = null;
  if (q !== null) {
    if (!/^\d{1,15}$/.test(q)) throw new ApiError("bad_request", "lastValidBlockHeight must be a non-negative integer");
    lvbh = Number(q);
  }
  return { body: await txStatus(getBotConnection("confirmed"), params.signature, lvbh, meta) };
});
