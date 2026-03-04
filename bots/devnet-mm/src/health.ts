/**
 * PERC-377: Health check HTTP server.
 * Exposes /health endpoint for monitoring and deployment health probes.
 */

import * as http from "http";
import type { FillerBot } from "./filler.js";
import type { MakerBot } from "./maker.js";
import type { TraderFleetBot } from "./trader-fleet.js";
import { log } from "./logger.js";

export function startHealthServer(
  port: number,
  filler: FillerBot | null,
  maker: MakerBot | null,
  host: string = "127.0.0.1",
  traderFleet: TraderFleetBot | null = null,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const fillerStatus = filler?.getStatus() ?? null;
      const makerStatus = maker?.getStatus() ?? null;
      const fleetStatus = traderFleet?.getStatus() ?? null;
      const status = {
        status: "ok",
        timestamp: new Date().toISOString(),
        filler: fillerStatus,
        maker: makerStatus,
        traderFleet: fleetStatus,
      };

      // Check if any bot is degraded
      if (fillerStatus && !fillerStatus.running) status.status = "degraded";
      if (makerStatus && !makerStatus.running) status.status = "degraded";

      const statusCode = status.status === "ok" ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
    } else if (req.url === "/metrics") {
      // Simple Prometheus-compatible metrics
      const lines: string[] = [];
      if (filler) {
        const s = filler.getStatus().stats;
        lines.push(`# TYPE percolator_filler_crank_cycles counter`);
        lines.push(`percolator_filler_crank_cycles ${s.crankCycles}`);
        lines.push(`# TYPE percolator_filler_crank_success counter`);
        lines.push(`percolator_filler_crank_success ${s.crankSuccess}`);
        lines.push(`# TYPE percolator_filler_crank_failed counter`);
        lines.push(`percolator_filler_crank_failed ${s.crankFailed}`);
        lines.push(`# TYPE percolator_filler_oracle_pushes counter`);
        lines.push(`percolator_filler_oracle_pushes ${s.oraclePushes}`);
        lines.push(`# TYPE percolator_filler_markets gauge`);
        lines.push(`percolator_filler_markets ${s.marketsActive}`);
      }
      if (maker) {
        const s = maker.getStatus().stats;
        lines.push(`# TYPE percolator_maker_quote_cycles counter`);
        lines.push(`percolator_maker_quote_cycles ${s.quoteCycles}`);
        lines.push(`# TYPE percolator_maker_trades_executed counter`);
        lines.push(`percolator_maker_trades_executed ${s.tradesExecuted}`);
        lines.push(`# TYPE percolator_maker_trades_failed counter`);
        lines.push(`percolator_maker_trades_failed ${s.tradesFailed}`);
        lines.push(`# TYPE percolator_maker_markets gauge`);
        lines.push(`percolator_maker_markets ${s.marketsActive}`);
      }
      if (traderFleet) {
        const s = traderFleet.getStatus().stats;
        lines.push(`# TYPE percolator_fleet_total_trades counter`);
        lines.push(`percolator_fleet_total_trades ${s.totalTrades}`);
        lines.push(`# TYPE percolator_fleet_total_failed counter`);
        lines.push(`percolator_fleet_total_failed ${s.totalFailed}`);
        lines.push(`# TYPE percolator_fleet_active_traders gauge`);
        lines.push(`percolator_fleet_active_traders ${s.activeTraders}`);
        lines.push(`# TYPE percolator_fleet_cycles counter`);
        lines.push(`percolator_fleet_cycles ${s.cycleCount}`);
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(lines.join("\n") + "\n");
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, host, () => {
    log("health", `Health endpoint: http://${host}:${port}/health`);
    log("health", `Metrics endpoint: http://${host}:${port}/metrics`);
  });

  return server;
}
