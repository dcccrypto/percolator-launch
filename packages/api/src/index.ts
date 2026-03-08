import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { createLogger, sendInfoAlert } from "@percolator/shared";
import { initSentry, sentryMiddleware, flushSentry } from "./middleware/sentry.js";

// Initialize Sentry before anything else
initSentry();
import { healthRoutes } from "./routes/health.js";
import { marketRoutes } from "./routes/markets.js";
import { tradeRoutes } from "./routes/trades.js";
import { priceRoutes } from "./routes/prices.js";
import { fundingRoutes } from "./routes/funding.js";
import { crankStatusRoutes } from "./routes/crank.js";
import { oracleRouterRoutes } from "./routes/oracle-router.js";
import { insuranceRoutes } from "./routes/insurance.js";
import { openInterestRoutes } from "./routes/open-interest.js";
import { statsRoutes } from "./routes/stats.js";
import { docsRoutes } from "./routes/docs.js";
import { setupWebSocket } from "./routes/ws.js";
import { readRateLimit, writeRateLimit } from "./middleware/rate-limit.js";
import { ipBlocklist } from "./middleware/ip-blocklist.js";
import { cacheMiddleware } from "./middleware/cache.js";

const logger = createLogger("api");

const app = new Hono();

// CORS Configuration
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : ["http://localhost:3000", "http://localhost:3001"];

// In production, CORS_ORIGINS must be explicitly set
if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGINS) {
  logger.error("CORS_ORIGINS environment variable is required in production");
  process.exit(1);
}

logger.info("CORS allowed origins", { origins: allowedOrigins });

app.use("*", cors({
  origin: (origin) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return null;
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return origin;
    }

    // Support wildcard patterns (e.g. *.vercel.app)
    for (const allowed of allowedOrigins) {
      if (allowed.startsWith("https://*.")) {
        const suffix = allowed.slice("https://*".length); // e.g. ".vercel.app"
        if (origin.startsWith("https://") && origin.endsWith(suffix)) {
          return origin;
        }
      }
    }
    
    // Reject disallowed origins
    logger.warn("CORS rejected origin", { origin });
    return null;
  },
  // Only allow GET + OPTIONS until write endpoints are implemented.
  // When mutation routes are added, expand this AND apply requireApiKey()
  // middleware to those routes. See middleware/auth.ts.
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-api-key"],
}));

// Default-deny for mutation methods. Until write endpoints are added,
// reject any POST/PUT/DELETE/PATCH requests that reach the API.
// When write routes are needed, apply requireApiKey() from middleware/auth.ts
// to those specific routes and remove this global guard.
app.use("*", async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    logger.warn("Blocked mutation request (no write endpoints)", {
      method,
      path: c.req.path,
    });
    return c.json({ error: "Method not allowed" }, 405);
  }
  return next();
});

// IP Blocklist Middleware — runs after CORS, before rate-limiting and auth.
// Configure via IP_BLOCKLIST env var (comma-separated IPs or CIDRs).
// Example: IP_BLOCKLIST=88.97.223.158,10.0.0.0/8
app.use("*", ipBlocklist());

// Compression Middleware (gzip/brotli for JSON responses)
app.use("*", compress());

// Sentry error tracking middleware
app.use("*", sentryMiddleware());

// Security Headers Middleware
app.use("*", async (c, next) => {
  await next();
  
  // Set security headers
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  
  // Content-Security-Policy for Swagger UI (allows unpkg.com for Swagger resources)
  c.header("Content-Security-Policy", "script-src 'self' unpkg.com; style-src 'self' unpkg.com 'unsafe-inline'");
  
  // Only add HSTS if using HTTPS
  const proto = c.req.header("x-forwarded-proto") || "http";
  if (proto === "https") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

// Rate Limiting Middleware
app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return readRateLimit()(c, next);
  }
  return writeRateLimit()(c, next);
});

// Response Caching Middleware (applied per-route)
// Cache read-heavy endpoints with varying TTLs:
// - /markets — 30s TTL
app.use("/markets", cacheMiddleware(30));
// - /stats — 60s TTL
app.use("/stats", cacheMiddleware(60));
// - /funding/global — 60s TTL
app.use("/funding/global", cacheMiddleware(60));

// Dynamic route caching (with path parameters) applied in route handlers
// - /markets/:slab — 10s TTL (handled in route)
// - /open-interest/:slab — 15s TTL (handled in route)
// - /funding/:slab — 30s TTL (handled in route)

app.route("/", healthRoutes());
app.route("/", marketRoutes());
app.route("/", tradeRoutes());
app.route("/", priceRoutes());
app.route("/", fundingRoutes());
app.route("/", crankStatusRoutes());
app.route("/", oracleRouterRoutes());
app.route("/", insuranceRoutes());
app.route("/", openInterestRoutes());
app.route("/", statsRoutes());
app.route("/", docsRoutes());

app.get("/", (c) => c.json({ 
  name: "@percolator/api", 
  version: "0.1.0",
  docs: "/docs"
}));

// Global error handler
app.onError((err, c) => {
  logger.error("Unhandled error", { 
    error: err.message, 
    stack: err.stack,
    endpoint: c.req.path,
    method: c.req.method
  });
  
  // Report to Sentry (sentryMiddleware may have already captured it,
  // but this ensures errors from middleware chain are also caught)
  import("@sentry/node").then((Sentry) => {
    Sentry.captureException(err, {
      tags: {
        endpoint: c.req.path,
        method: c.req.method,
        handler: "onError",
      },
    });
  }).catch(() => {});
  
  return c.json({ error: "Internal server error" }, 500);
});

const port = Number(process.env.API_PORT ?? 3001);
const server = serve({ fetch: app.fetch, port }, async (info) => {
  logger.info("Percolator API started", { port: info.port });
  
  // Send startup alert
  await sendInfoAlert("API service started", [
    { name: "Port", value: info.port.toString(), inline: true },
  ]);
});

const wss = setupWebSocket(server as unknown as import("node:http").Server);

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutdown initiated", { signal });
  
  try {
    // Flush Sentry events before shutting down
    await flushSentry(2000);
    
    // Send shutdown alert
    await sendInfoAlert("API service shutting down", [
      { name: "Signal", value: signal, inline: true },
    ]);
    
    // Close WebSocket server (stops accepting new connections)
    logger.info("Closing WebSocket server");
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.info("WebSocket server closed");
    
    // Close HTTP server (stops accepting new requests)
    logger.info("Closing HTTP server");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.info("HTTP server closed");
    
    // Note: Supabase client doesn't need explicit cleanup (connection pooling handled automatically)
    
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during shutdown", { error: err });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
