import { Hono } from "hono";
import { getConnection } from "../utils/solana.js";

const startTime = Date.now();

export function healthRoutes(deps: {
  crankService: {
    getStatus: () => Record<string, unknown>;
    getLastCycleResult: () => { success: number; failed: number; skipped: number };
    isRunning: boolean;
  };
  liquidationService?: { getStatus: () => Record<string, unknown> };
}): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    let rpcLatencyMs = -1;
    let rpcStatus: "ok" | "degraded" | "down" = "down";

    try {
      const start = Date.now();
      await getConnection().getSlot();
      rpcLatencyMs = Date.now() - start;
      rpcStatus = rpcLatencyMs < 5000 ? "ok" : "degraded";
    } catch {
      rpcStatus = "down";
    }

    let crankStatus: Record<string, unknown> = {};
    let crankCycle = { success: 0, failed: 0, skipped: 0 };
    let crankRunning = false;
    try {
      crankStatus = deps.crankService.getStatus();
      crankCycle = deps.crankService.getLastCycleResult();
      crankRunning = deps.crankService.isRunning;
    } catch {
      // Service may not be initialized yet
    }

    let liquidationStatus: Record<string, unknown> | null = null;
    try {
      liquidationStatus = deps.liquidationService?.getStatus() ?? null;
    } catch {
      // ignore
    }

    const overallStatus = rpcStatus === "down" ? "degraded" : "ok";

    return c.json({
      status: overallStatus,
      uptimeMs: Date.now() - startTime,
      services: {
        rpc: { status: rpcStatus, latencyMs: rpcLatencyMs },
        crank: {
          status: crankRunning ? "running" : "stopped",
          markets: Object.keys(crankStatus).length,
          lastCycle: crankCycle,
        },
        liquidation: liquidationStatus,
      },
      crankStatus,
    });
  });

  return app;
}
