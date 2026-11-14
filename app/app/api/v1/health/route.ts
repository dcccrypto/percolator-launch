/** GET /api/v1/health: RPC slot and block height, KV backend, and whether the bot API is on. For uptime checks. */
import { getServerConnection } from "@/lib/server-rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { getKv } from "@/lib/bot-api/kv";
import { getMaintenanceConfig } from "@/lib/maintenance";
import { ApiError } from "@/lib/bot-api/errors";

export const dynamic = "force-dynamic";

export const GET = botRoute({ route: "/v1/health", scope: "read", weight: 1 }, async ({ meta }) => {
  const conn = getServerConnection("confirmed");
  const t0 = Date.now();
  let slot: number, blockHeight: number;
  try {
    meta.rpcCalls += 2;
    [slot, blockHeight] = await Promise.all([conn.getSlot("confirmed"), conn.getBlockHeight("confirmed")]);
  } catch {
    throw new ApiError("rpc_unavailable");
  }
  const kv = getKv();
  return {
    body: {
      status: "ok",
      version: "v1",
      slot,
      blockHeight,
      rpcMs: Date.now() - t0,
      observedAt: new Date().toISOString(),
      kv: { backend: kv.backend, degraded: kv.degraded() },
      writesPaused: getMaintenanceConfig().blockWrites,
    },
  };
});
