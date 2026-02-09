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
import { insuranceRoutes } from "./routes/insurance.js";
import { oracleRouterRoutes } from "./routes/oracle-router.js";

// Services
const oracleService = new OracleService();
const priceEngine = new PriceEngine();
const crankService = new CrankService(oracleService);
const liquidationService = new LiquidationService(oracleService);
const lifecycleManager = new MarketLifecycleManager(crankService, oracleService);
const insuranceService = new InsuranceLPService(crankService);

// Hono app
const app = new Hono();
// C1: CORS lockdown — only allow configured origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "https://percolator-launch.vercel.app,http://localhost:3000").split(",").map(s => s.trim()).filter(Boolean);
app.use("*", cors({
  origin: allowedOrigins,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-api-key"],
}));

// Mount routes
app.route("/", healthRoutes({ crankService, liquidationService }));
app.route("/", marketRoutes({ crankService, lifecycleManager }));
app.route("/", priceRoutes({ oracleService, priceEngine }));
app.route("/", crankRoutes({ crankService }));
app.route("/", insuranceRoutes({ insuranceService }));
app.route("/", oracleRouterRoutes());

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
  }).catch((err) => {
    console.error("Failed to start crank service:", err);
  });
} else {
  console.warn("⚠️  CRANK_KEYPAIR not set — crank service disabled");
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  try {
    priceEngine.stop();
    crankService.stop();
    liquidationService.stop();
    insuranceService.stop();
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
