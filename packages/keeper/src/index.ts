import "dotenv/config";
import http from "node:http";
import { config, createLogger, initSentry, captureException, sendInfoAlert, createServiceMonitors } from "@percolator/shared";
import { OracleService } from "./services/oracle.js";
import { CrankService } from "./services/crank.js";
import { LiquidationService } from "./services/liquidation.js";

// Monitoring — alerts to Discord on threshold breaches
export const monitors = createServiceMonitors("Keeper");

// Initialize Sentry first
initSentry("keeper");

const logger = createLogger("keeper");

if (!config.crankKeypair) {
  throw new Error("CRANK_KEYPAIR must be set for keeper service");
}

logger.info("Keeper service starting");

const oracleService = new OracleService();
const crankService = new CrankService(oracleService);
const liquidationService = new LiquidationService(oracleService);

// Health state tracking
let lastSuccessfulCrankTime = 0;
let lastOracleUpdateTime = 0;

// Subscribe to crank events to track health
crankService.getMarkets().forEach((_, slabAddress) => {
  const checkCrankHealth = () => {
    const markets = crankService.getMarkets();
    for (const [_, state] of markets) {
      if (state.lastCrankTime > lastSuccessfulCrankTime) {
        lastSuccessfulCrankTime = state.lastCrankTime;
      }
    }
  };
  setInterval(checkCrankHealth, 10_000); // Check every 10s
});

// Health endpoint
const healthPort = Number(process.env.KEEPER_HEALTH_PORT ?? 8081);
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    const markets = crankService.getMarkets();
    const marketsTracked = markets.size;
    
    // Find the most recent crank time across all markets
    let mostRecentCrank = 0;
    for (const [_, state] of markets) {
      if (state.lastCrankTime > mostRecentCrank) {
        mostRecentCrank = state.lastCrankTime;
      }
    }
    
    // Find the most recent oracle update
    let mostRecentOracle = 0;
    for (const [slabAddress] of markets) {
      const price = oracleService.getCurrentPrice(slabAddress);
      if (price && price.timestamp > mostRecentOracle) {
        mostRecentOracle = price.timestamp;
      }
    }
    
    const now = Date.now();
    const timeSinceLastCrank = mostRecentCrank > 0 ? now - mostRecentCrank : Infinity;
    const timeSinceLastOracle = mostRecentOracle > 0 ? now - mostRecentOracle : Infinity;
    
    // Determine health status
    let status: "ok" | "degraded" | "down";
    if (timeSinceLastCrank < 60_000) {
      status = "ok";
    } else if (timeSinceLastCrank < 300_000) {
      status = "degraded";
    } else {
      status = "down";
    }
    
    const healthData = {
      status,
      lastCrankTime: mostRecentCrank,
      lastOracleUpdate: mostRecentOracle,
      marketsTracked,
      timeSinceLastCrankMs: timeSinceLastCrank === Infinity ? null : timeSinceLastCrank,
      timeSinceLastOracleMs: timeSinceLastOracle === Infinity ? null : timeSinceLastOracle,
      monitors: {
        rpc: monitors.rpc.getStatus(),
        scan: monitors.scan.getStatus(),
        oracle: monitors.oracle.getStatus(),
      },
    };
    
    const statusCode = status === "down" ? 503 : 200;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(healthData));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

healthServer.listen(healthPort, () => {
  logger.info("Health endpoint started", { port: healthPort });
});

async function start() {
  const markets = await crankService.discover();
  logger.info("Markets discovered", { count: markets.length });
  crankService.start();
  logger.info("Crank service started");
  liquidationService.start(() => crankService.getMarkets());
  logger.info("Liquidation scanner started");
  
  // Send startup alert
  await sendInfoAlert("Keeper service started", [
    { name: "Markets Tracked", value: markets.length.toString(), inline: true },
    { name: "Health Endpoint", value: `http://localhost:${healthPort}/health`, inline: true },
  ]);
}

start().catch((err) => {
  logger.error("Failed to start keeper", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutdown initiated", { signal });
  
  try {
    // Send shutdown alert
    await sendInfoAlert("Keeper service shutting down", [
      { name: "Signal", value: signal, inline: true },
    ]);
    
    // Close health server
    logger.info("Closing health server");
    await new Promise<void>((resolve, reject) => {
      healthServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Stop crank service (clears timers, stops processing)
    logger.info("Stopping crank service");
    crankService.stop();
    
    // Stop liquidation service (clears timers)
    logger.info("Stopping liquidation service");
    liquidationService.stop();
    
    // Note: Solana connection doesn't need explicit cleanup
    // Oracle service has no persistent state to clean up
    
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during shutdown", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
