/** GET /api/v1/health: RPC slot and block height, KV backend, and whether the bot API is on. For uptime checks. */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { anonReadsAllowed, memoryKvOnDeployedBuild } from "@/lib/bot-api/config";
import { trustedProxyDepth } from "@/lib/trusted-proxy-depth";
import { getClientIp } from "@/lib/get-client-ip";
import { botRoute } from "@/lib/bot-api/handler";
import { getKv } from "@/lib/bot-api/kv";
import { getMaintenanceConfig } from "@/lib/maintenance";
import { ApiError } from "@/lib/bot-api/errors";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute({ route: "/v1/health", scope: "read", weight: 1 }, async ({ meta, req }) => {
  const conn = getBotConnection("confirmed");
  const t0 = Date.now();
  let slot: number, blockHeight: number;
  try {
    meta.rpcCalls += 2;
    [slot, blockHeight] = await Promise.all([conn.getSlot("confirmed"), conn.getBlockHeight("confirmed")]);
  } catch {
    throw new ApiError("rpc_unavailable");
  }
  const kv = getKv();
  const kvDegraded = kv.degraded();
  const memoryOnDeployed = memoryKvOnDeployedBuild(kv.backend);
  // Keys cannot verify (or only per instance) in either case: the API is not usable, say so with a 503.
  const unusable = kvDegraded || memoryOnDeployed;
  const clientIpResolved = getClientIp(req) !== "unknown";
  const ipMisconfigured = !clientIpResolved && Boolean(process.env.VERCEL);
  const status = unusable ? "degraded" : ipMisconfigured ? "degraded" : "ok";
  return {
    status: unusable ? 503 : 200,
    body: {
      status,
      version: "v1",
      slot,
      blockHeight,
      rpcMs: Date.now() - t0,
      observedAt: new Date().toISOString(),
      kv: { backend: kv.backend, degraded: kvDegraded, memoryOnDeployedBuild: memoryOnDeployed },
      // When the address cannot be resolved on a deployed build, anonymous callers are refused (client_ip_unknown).
      clientIp: { resolved: clientIpResolved, trustedProxyDepth: trustedProxyDepth() },
      writesPaused: getMaintenanceConfig().blockWrites,
      // Switch state an operator needs at a glance: the API answering means BOT_API_ENABLED is on; anonymous reads and the
      // app-wide write pause are the other two levers.
      switches: { botApiEnabled: true, anonReads: anonReadsAllowed(), writesPaused: getMaintenanceConfig().blockWrites },
    },
  };
});
