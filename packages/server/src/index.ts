import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { OracleService } from "./services/oracle.js";
import { CrankService } from "./services/crank.js";
import { MarketLifecycleManager } from "./services/lifecycle.js";
import { healthRoutes } from "./routes/health.js";
import { marketRoutes } from "./routes/markets.js";
import { priceRoutes } from "./routes/prices.js";
import { crankRoutes } from "./routes/crank.js";
import { setupWebSocket } from "./routes/ws.js";
import { PriceEngine } from "./services/PriceEngine.js";
import { LiquidationService } from "./services/liquidation.js";
import { InsuranceLPService } from "./services/InsuranceLPService.js";
import { TradeIndexerPolling } from "./services/TradeIndexer.js";
import { HeliusWebhookManager } from "./services/HeliusWebhookManager.js";
import { StatsCollector } from "./services/StatsCollector.js";
import { webhookRoutes } from "./routes/webhook.js";
import { tradeRoutes } from "./routes/trades.js";
import { oracleRouterRoutes } from "./routes/oracle-router.js";
import { readRateLimit, writeRateLimit } from "./middleware/rate-limit.js";
import { SimulationService, type Scenario } from "./services/SimulationService.js";

// Services
const oracleService = new OracleService();
const priceEngine = new PriceEngine();
const crankService = new CrankService(oracleService);
const liquidationService = new LiquidationService(oracleService);
const lifecycleManager = new MarketLifecycleManager(crankService, oracleService);
const insuranceService = new InsuranceLPService(crankService);
const tradeIndexer = new TradeIndexerPolling();
const webhookManager = new HeliusWebhookManager();
const statsCollector = new StatsCollector(crankService, oracleService);
const simulationService = new SimulationService();

// Hono app
const app = new Hono();
// C1: CORS lockdown — only allow configured origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "https://percolatorlaunch.com,http://localhost:3000").split(",").map(s => s.trim()).filter(Boolean);
app.use("*", cors({
  origin: allowedOrigins,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-api-key"],
}));

// Global rate limiting — read for GET, write for POST/PUT/DELETE
app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return readRateLimit()(c, next);
  }
  return writeRateLimit()(c, next);
});

// Mount routes
app.route("/", healthRoutes({ crankService, liquidationService }));
app.route("/", marketRoutes({ crankService, lifecycleManager }));
app.route("/", priceRoutes({ oracleService, priceEngine }));
app.route("/", crankRoutes({ crankService }));
app.route("/", oracleRouterRoutes());
app.route("/", webhookRoutes());
app.route("/", tradeRoutes());

// Webhook diagnostics
app.get("/webhook/status", async (c) => {
  const status = webhookManager.getStatus();
  const webhooks = await webhookManager.listWebhooks();
  return c.json({ ...status, registeredWebhooks: webhooks?.length ?? "unknown" });
});
app.post("/webhook/re-register", async (c) => {
  const result = await webhookManager.reRegister();
  return c.json(result);
});

// Simulation endpoints
app.post("/api/simulation/start", async (c) => {
  const body = await c.req.json() as {
    slabAddress: string;
    oracleSecret: string;
    startPriceE6?: number;
    intervalMs?: number;
    tokenSymbol?: string;
    tokenName?: string;
    mintAddress?: string;
    creatorWallet?: string;
  };
  const result = await simulationService.start(body);
  return c.json(result, result.ok ? 200 : 400);
});

app.post("/api/simulation/stop", async (c) => {
  const result = await simulationService.stop();
  return c.json(result);
});

app.get("/api/simulation", (c) => {
  const state = simulationService.getState();
  return c.json(state ?? { running: false });
});

app.post("/api/simulation/scenario", async (c) => {
  const body = await c.req.json() as { scenario: Scenario };
  const result = simulationService.setScenario(body.scenario);
  return c.json(result, result.ok ? 200 : 400);
});

app.get("/api/simulation/history", (c) => {
  const history = simulationService.getHistory();
  return c.json(history);
});

app.get("/api/simulation/bots", (c) => {
  const state = simulationService.getState();
  return c.json(state?.bots ?? []);
});

// Root
app.get("/", (c) => c.json({ name: "@percolator/server", version: "0.1.0" }));

// Start
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`🚀 Percolator server running on http://localhost:${info.port}`);
});

// WebSocket on the same HTTP server
setupWebSocket(server as unknown as import("node:http").Server, oracleService, priceEngine);

// Start real-time price engine
priceEngine.start();
console.log("📡 PriceEngine started — listening for Helius account changes");

// Start crank service if keypair is configured
if (config.crankKeypair) {
  crankService.discover().then((markets) => {
    crankService.start();
    console.log("⚡ Crank service started");

    // Auto-subscribe PriceEngine to all discovered markets
    for (const market of markets) {
      priceEngine.subscribeToSlab(market.slabAddress.toBase58());
    }
    if (markets.length > 0) {
      console.log(`📡 PriceEngine subscribed to ${markets.length} market(s)`);
    }

    // Start liquidation scanner
    liquidationService.start(() => crankService.getMarkets());
    console.log("🔍 Liquidation scanner started");

    // Start insurance LP service
    insuranceService.start();
    console.log("🛡️  Insurance LP service started");

    // Start trade indexer (polling backup)
    tradeIndexer.start();
    console.log("📊 Trade indexer started (polling backup)");

    // Start stats collector (populates market_stats + oracle_prices tables)
    statsCollector.start();
    console.log("📈 Stats collector started (market_stats + oracle_prices)");

    // Register Helius webhook for primary trade indexing
    webhookManager.start().then(() => {
      console.log("🪝 Helius webhook manager started");
    }).catch((err) => {
      console.error("Failed to start webhook manager:", err);
    });
  }).catch((err) => {
    console.error("Failed to start crank service:", err);
  });
  // Trade indexer also started inside crank block (reactive mode)
} else {
  console.warn("⚠️  CRANK_KEYPAIR not set — crank service disabled");
  // Still start trade indexer in polling-only mode (no crank events, but polls markets)
  tradeIndexer.start();
  console.log("📊 Trade indexer started (polling-only mode, no crank keypair)");

  // Register Helius webhook even without crank keypair
  webhookManager.start().then(() => {
    console.log("🪝 Helius webhook manager started");
  }).catch((err) => {
    console.error("Failed to start webhook manager:", err);
  });
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  try {
    priceEngine.stop();
    crankService.stop();
    liquidationService.stop();
    insuranceService.stop();
    tradeIndexer.stop();
    webhookManager.stop();
    statsCollector.stop();
    if (server && typeof (server as any).close === "function") {
      (server as any).close();
    }
  } catch (err) {
    console.error("Error during shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
