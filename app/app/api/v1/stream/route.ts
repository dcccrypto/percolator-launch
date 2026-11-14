/**
 * GET /api/v1/stream?markets=a,b (max 10): Server-Sent Events. A `market` snapshot per market every 2 s, a `heartbeat` every
 * 10 s, `id:` = cluster slot, `retry: 2000`; closes after 55 s with an `end` event, the client reconnects with Last-Event-ID.
 * Wire format and the wrapper that reuses botRoute's auth and limit: lib/bot-api/stream.ts.
 */
import { getServerConnection } from "@/lib/server-rpc";
import { ApiError } from "@/lib/bot-api/errors";
import { parsePubkey, queryParam } from "@/lib/bot-api/reads/common";
import { loadMarketsByKey } from "@/lib/bot-api/reads/market-source";
import { decodeMarket } from "@/lib/bot-api/reads/market";
import { sseRoute, type StreamTick } from "@/lib/bot-api/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_STREAM_MARKETS = 10;

export const GET = sseRoute({ route: "/v1/stream", scope: "read", weight: 5 }, async ({ req, meta }) => {
  const raw = queryParam(new URL(req.url), "markets");
  if (!raw) throw new ApiError("bad_request", "markets is required: a comma-separated list of market addresses");
  const parts = [...new Set(raw.split(",").map((s) => s.trim()))];
  if (parts.length > MAX_STREAM_MARKETS || parts.some((p) => p === "")) throw new ApiError("bad_request", `markets must be 1-${MAX_STREAM_MARKETS} distinct addresses`);
  const keys = parts.map((p) => parsePubkey(p, "markets"));
  const connection = getServerConnection("confirmed");
  const read = async (m: { rpcCalls: number }): Promise<StreamTick> => {
    const { slot, markets } = await loadMarketsByKey(connection, m, keys);
    return {
      slot,
      items: markets.map((rm, i) => {
        const market = keys[i].toBase58();
        if (!rm) return { market, error: { code: "market_not_found", retryable: false } };
        try {
          const v = decodeMarket(rm.raw, { market: keys[i], programId: rm.programId, slot });
          return {
            market,
            snapshot: {
              market,
              effectivePriceE6: v.effectivePriceE6,
              targetPriceE6: v.targetPriceE6,
              oracle: { ageSlots: v.oracle.ageSlots, stale: v.oracle.stale },
              openInterest: v.openInterest,
            },
          };
        } catch (e) {
          const code = e instanceof ApiError ? e.code : "market_unreadable";
          return { market, error: { code, retryable: e instanceof ApiError ? e.retryable : true } };
        }
      }),
    };
  };
  // Validate up front, so a missing market is a 404 before the stream opens.
  const first = await read(meta);
  const missing = first.items.find((i) => "error" in i && i.error.code === "market_not_found");
  if (missing) throw new ApiError("market_not_found");
  const dead = first.items.find((i) => "error" in i && (i.error.code === "market_unsupported" || i.error.code === "market_unreadable"));
  if (dead && "error" in dead) throw new ApiError(dead.error.code as "market_unsupported" | "market_unreadable");
  return { read: () => read({ rpcCalls: 0 }) };
});
