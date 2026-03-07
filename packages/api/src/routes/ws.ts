import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eventBus, getSupabase, createLogger, sanitizeSlabAddress } from "@percolator/shared";

const logger = createLogger("api:ws");

// H2: Configurable limits
const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS ?? 1000); // Increased global limit
const MAX_CONNECTIONS_PER_SLAB = 100; // New: per-slab connection limit
const MAX_BUFFER_BYTES = 64 * 1024; // 64KB
const MAX_SUBSCRIPTIONS_PER_CLIENT = 50; // Prevent Helius WS subscription exhaustion
const MAX_GLOBAL_SUBSCRIPTIONS = 1000; // Global subscription cap to prevent DoS
const MAX_CONNECTIONS_PER_IP = 5; // Max concurrent connections per IP

// Authentication settings
// In production, WS_AUTH_REQUIRED must be explicitly set. Defaults to true unless NODE_ENV=development.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const WS_AUTH_REQUIRED = process.env.WS_AUTH_REQUIRED !== undefined
  ? process.env.WS_AUTH_REQUIRED === "true"
  : IS_PRODUCTION; // Default: required in production, optional in development
const WS_AUTH_SECRET = process.env.WS_AUTH_SECRET;
const AUTH_TIMEOUT_MS = 5_000; // 5 seconds to authenticate

// Validate WS auth configuration at startup
if (IS_PRODUCTION && !WS_AUTH_SECRET) {
  logger.error("FATAL: WS_AUTH_SECRET must be set in production");
  process.exit(1);
}

if (WS_AUTH_REQUIRED && !WS_AUTH_SECRET) {
  logger.error("FATAL: WS_AUTH_REQUIRED=true but WS_AUTH_SECRET is not set");
  process.exit(1);
}

if (!WS_AUTH_SECRET) {
  logger.warn("WS_AUTH_SECRET not set — using dev-only fallback. DO NOT use in production.");
}

// Use a fallback secret only for development when auth is not required
const WS_SECRET = WS_AUTH_SECRET || (IS_PRODUCTION ? "" : "percolator-ws-dev-secret-not-for-production");

// BH2: Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const PONG_TIMEOUT_MS = 10_000; // 10 seconds to respond to ping

// Price update batching configuration
const PRICE_BATCH_INTERVAL_MS = 500; // Batch price updates every 500ms per slab

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>; // Channel subscriptions: "price:SOL", "trades:BTC", etc.
  pingInterval?: ReturnType<typeof setInterval>; // BH2: Heartbeat timer
  pongTimeout?: ReturnType<typeof setTimeout>; // BH2: Pong response timeout
  isAlive: boolean; // BH2: Track pong responses
  authenticated: boolean; // Auth status
  authenticatedSlab?: string; // Slab address from auth token (if slab-bound)
  ip: string; // Client IP address
  authTimeout?: ReturnType<typeof setTimeout>; // Auth timeout timer
}

// Track global subscription count across all clients
let globalSubscriptionCount = 0;

// Track connections per IP
const connectionsPerIp = new Map<string, number>();

// Auth failure rate limiting per IP (issue #839: connection flood from repeat auth failures)
// Tracks recent auth failures to temporarily ban repeat offenders.
const AUTH_FAILURE_WINDOW_MS = 60_000;   // 60-second rolling window
const AUTH_FAILURE_BAN_THRESHOLD = 10;   // ban after 10 failures in the window
const AUTH_FAILURE_BAN_DURATION_MS = 300_000; // 5-minute ban

interface AuthFailureRecord {
  count: number;
  windowStart: number;  // start of current counting window
  bannedUntil: number;  // timestamp after which ban is lifted (0 = not banned)
}
const authFailuresPerIp = new Map<string, AuthFailureRecord>();

/**
 * Record an auth failure for an IP. Returns true if the IP should now be banned.
 */
function recordAuthFailure(ip: string): void {
  const now = Date.now();
  let rec = authFailuresPerIp.get(ip);
  if (!rec) {
    rec = { count: 0, windowStart: now, bannedUntil: 0 };
    authFailuresPerIp.set(ip, rec);
  }
  // Reset window if expired
  if (now - rec.windowStart > AUTH_FAILURE_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count++;
  if (rec.count >= AUTH_FAILURE_BAN_THRESHOLD) {
    rec.bannedUntil = now + AUTH_FAILURE_BAN_DURATION_MS;
    logger.warn("IP temporarily banned for repeated auth failures", {
      ip,
      failures: rec.count,
      banUntil: new Date(rec.bannedUntil).toISOString(),
    });
  }
}

/**
 * Returns true if the IP is currently banned due to too many auth failures.
 */
function isAuthBanned(ip: string): boolean {
  const rec = authFailuresPerIp.get(ip);
  if (!rec || rec.bannedUntil === 0) return false;
  if (Date.now() >= rec.bannedUntil) {
    // Ban expired — clear it
    authFailuresPerIp.delete(ip);
    return false;
  }
  return true;
}

// Periodically sweep stale auth failure records to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authFailuresPerIp.entries()) {
    const stale = rec.bannedUntil > 0
      ? now >= rec.bannedUntil + AUTH_FAILURE_BAN_DURATION_MS
      : now - rec.windowStart > AUTH_FAILURE_WINDOW_MS * 2;
    if (stale) authFailuresPerIp.delete(ip);
  }
}, AUTH_FAILURE_BAN_DURATION_MS);

// Track connections per slab (for per-slab limits)
const connectionsPerSlab = new Map<string, Set<WsClient>>();

// Price update batching: track pending updates per slab
interface PendingPriceUpdate {
  slabAddress: string;
  data: any;
  timestamp: number;
}
const pendingPriceUpdates = new Map<string, PendingPriceUpdate>();
const priceUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Metrics tracking
interface Metrics {
  totalConnections: number;
  connectionsPerSlab: Map<string, number>;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastResetTime: number;
}

const metrics: Metrics = {
  totalConnections: 0,
  connectionsPerSlab: new Map(),
  messagesReceived: 0,
  messagesSent: 0,
  bytesReceived: 0,
  bytesSent: 0,
  lastResetTime: Date.now(),
};

// Reset rate metrics every minute for messages/sec and bytes/sec
setInterval(() => {
  const now = Date.now();
  const elapsedSec = (now - metrics.lastResetTime) / 1000;
  
  logger.info("WebSocket metrics", {
    totalConnections: metrics.totalConnections,
    messagesPerSec: (metrics.messagesReceived / elapsedSec).toFixed(2),
    bytesPerSec: (metrics.bytesSent / elapsedSec).toFixed(0),
  });
  
  metrics.messagesReceived = 0;
  metrics.messagesSent = 0;
  metrics.bytesReceived = 0;
  metrics.bytesSent = 0;
  metrics.lastResetTime = now;
}, 60_000);

/**
 * Extract client IP from request
 * Uses the last IP in X-Forwarded-For chain to prevent IP spoofing
 */
/**
 * Extract client IP respecting TRUSTED_PROXY_DEPTH.
 * See rate-limit.ts for full documentation.
 */
const WS_PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));

function getClientIp(req: IncomingMessage): string {
  if (WS_PROXY_DEPTH === 0) {
    return req.socket.remoteAddress || "unknown";
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const ips = forwarded.split(",").map(ip => ip.trim()).filter(Boolean);
    const idx = Math.max(0, ips.length - WS_PROXY_DEPTH);
    return ips[idx] || req.socket.remoteAddress || "unknown";
  }
  return req.socket.remoteAddress || "unknown";
}

/**
 * Generate an auth token (HMAC of slab address + timestamp)
 * This is a simple token system - can be upgraded to JWT later
 */
export function generateWsToken(slabAddress: string): string {
  const timestamp = Date.now();
  const payload = `${slabAddress}:${timestamp}`;
  const hmac = createHmac("sha256", WS_SECRET);
  hmac.update(payload);
  return `${payload}:${hmac.digest("hex")}`;
}

/**
 * Verify an auth token and optionally validate slab binding
 * @param token The authentication token
 * @param expectedSlab Optional slab address to verify against token
 * @returns Object with isValid boolean and slabAddress string (or null)
 */
function verifyWsToken(token: string, expectedSlab?: string): { isValid: boolean; slabAddress: string | null } {
  try {
    const parts = token.split(":");
    if (parts.length !== 3) return { isValid: false, slabAddress: null };
    
    const [slabAddress, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);
    
    // Check timestamp is within last 5 minutes
    const now = Date.now();
    if (now - timestamp > 5 * 60 * 1000) {
      return { isValid: false, slabAddress: null };
    }
    
    // Verify HMAC
    const payload = `${slabAddress}:${timestampStr}`;
    const hmac = createHmac("sha256", WS_SECRET);
    hmac.update(payload);
    const expectedSignature = hmac.digest("hex");
    
    const sigBuf = Buffer.from(signature, "utf8");
    const expectedBuf = Buffer.from(expectedSignature, "utf8");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return { isValid: false, slabAddress: null };
    }
    
    // If expectedSlab is provided, verify token is bound to that slab
    if (expectedSlab && slabAddress !== expectedSlab) {
      logger.warn("Token slab mismatch", { tokenSlab: slabAddress, expectedSlab });
      return { isValid: false, slabAddress: null };
    }
    
    return { isValid: true, slabAddress };
  } catch {
    return { isValid: false, slabAddress: null };
  }
}

/**
 * Extract slab address from channel name (e.g., "price:SOL" -> "SOL")
 */
function extractSlabFromChannel(channel: string): string | null {
  const parts = channel.split(":");
  if (parts.length === 2) {
    return parts[1];
  }
  return null;
}

/**
 * Get all slabs a client is subscribed to
 */
function getClientSlabs(client: WsClient): Set<string> {
  const slabs = new Set<string>();
  for (const channel of client.subscriptions) {
    const slab = extractSlabFromChannel(channel);
    if (slab) {
      slabs.add(slab);
    }
  }
  return slabs;
}

/**
 * Add client to slab tracking
 */
function addClientToSlab(client: WsClient, slabAddress: string): void {
  if (!connectionsPerSlab.has(slabAddress)) {
    connectionsPerSlab.set(slabAddress, new Set());
  }
  connectionsPerSlab.get(slabAddress)!.add(client);
  metrics.connectionsPerSlab.set(slabAddress, connectionsPerSlab.get(slabAddress)!.size);
}

/**
 * Remove client from slab tracking
 */
function removeClientFromSlab(client: WsClient, slabAddress: string): void {
  const slabClients = connectionsPerSlab.get(slabAddress);
  if (slabClients) {
    slabClients.delete(client);
    if (slabClients.size === 0) {
      connectionsPerSlab.delete(slabAddress);
      metrics.connectionsPerSlab.delete(slabAddress);
    } else {
      metrics.connectionsPerSlab.set(slabAddress, slabClients.size);
    }
  }
}

/**
 * Broadcast batched price update for a slab
 */
function flushPriceUpdate(slabAddress: string): void {
  const pending = pendingPriceUpdates.get(slabAddress);
  if (!pending) return;
  
  pendingPriceUpdates.delete(slabAddress);
  priceUpdateTimers.delete(slabAddress);
  
  const channel = `price:${slabAddress}`;
  const msg = JSON.stringify({
    type: "price",
    slab: slabAddress,
    price: pending.data.priceE6 / 1_000_000,
    markPrice: pending.data.markPriceE6 ? pending.data.markPriceE6 / 1_000_000 : undefined,
    indexPrice: pending.data.indexPriceE6 ? pending.data.indexPriceE6 / 1_000_000 : undefined,
    timestamp: pending.timestamp,
  });
  
  const slabClients = connectionsPerSlab.get(slabAddress);
  if (!slabClients) return;
  
  for (const client of slabClients) {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      client.subscriptions.has(channel)
    ) {
      if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) continue;
      client.ws.send(msg);
      metrics.messagesSent++;
      metrics.bytesSent += msg.length;
    }
  }
}

/**
 * Get WebSocket metrics for /ws/stats endpoint
 */
export function getWebSocketMetrics(): any {
  const now = Date.now();
  const elapsedSec = (now - metrics.lastResetTime) / 1000;
  
  return {
    totalConnections: metrics.totalConnections,
    connectionsPerSlab: Object.fromEntries(metrics.connectionsPerSlab),
    messagesPerSec: parseFloat((metrics.messagesReceived / elapsedSec).toFixed(2)),
    bytesPerSec: parseInt((metrics.bytesSent / elapsedSec).toFixed(0), 10),
    limits: {
      maxGlobalConnections: MAX_WS_CONNECTIONS,
      maxConnectionsPerSlab: MAX_CONNECTIONS_PER_SLAB,
      maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP,
    },
  };
}

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  // H2: Use Set for O(1) removal
  const clients = new Set<WsClient>();

  // Broadcast price updates to subscribed clients (with batching)
  eventBus.on("price.updated", (payload: any) => {
    const slabAddress = payload.slabAddress;
    
    // Check if anyone is subscribed to price updates for this slab
    const slabClients = connectionsPerSlab.get(slabAddress);
    if (!slabClients || slabClients.size === 0) {
      return; // No subscribers, skip
    }
    
    // Store pending update (overwrites previous if exists)
    pendingPriceUpdates.set(slabAddress, {
      slabAddress,
      data: payload.data,
      timestamp: payload.timestamp,
    });
    
    // If no timer exists for this slab, create one
    if (!priceUpdateTimers.has(slabAddress)) {
      const timer = setTimeout(() => {
        flushPriceUpdate(slabAddress);
      }, PRICE_BATCH_INTERVAL_MS);
      priceUpdateTimers.set(slabAddress, timer);
    }
    // Otherwise, the existing timer will flush the latest update
  });

  // Broadcast trade events to subscribed clients
  eventBus.on("trade.executed", (payload: any) => {
    const slabAddress = payload.slabAddress;
    const channel = `trades:${slabAddress}`;
    
    // Check if anyone is subscribed
    const slabClients = connectionsPerSlab.get(slabAddress);
    if (!slabClients || slabClients.size === 0) {
      return;
    }
    
    const msg = JSON.stringify({
      type: "trade",
      slab: slabAddress,
      side: payload.data.side,
      size: payload.data.size,
      price: payload.data.price,
      timestamp: payload.timestamp,
    });

    for (const client of slabClients) {
      if (
        client.ws.readyState === WebSocket.OPEN &&
        client.subscriptions.has(channel)
      ) {
        if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) continue;
        client.ws.send(msg);
        metrics.messagesSent++;
        metrics.bytesSent += msg.length;
      }
    }
  });

  // Broadcast funding rate updates to subscribed clients
  eventBus.on("funding.updated", (payload: any) => {
    const slabAddress = payload.slabAddress;
    const channel = `funding:${slabAddress}`;
    
    const slabClients = connectionsPerSlab.get(slabAddress);
    if (!slabClients || slabClients.size === 0) {
      return;
    }
    
    const msg = JSON.stringify({
      type: "funding",
      slab: slabAddress,
      rate: payload.data.rate,
      timestamp: payload.timestamp,
    });

    for (const client of slabClients) {
      if (
        client.ws.readyState === WebSocket.OPEN &&
        client.subscriptions.has(channel)
      ) {
        if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) continue;
        client.ws.send(msg);
        metrics.messagesSent++;
        metrics.bytesSent += msg.length;
      }
    }
  });

  wss.on("connection", (ws, req: IncomingMessage) => {
    const clientIp = getClientIp(req);
    
    // H2: Reject if at max connections
    if (clients.size >= MAX_WS_CONNECTIONS) {
      logger.warn("Max global WS connections reached", { ip: clientIp });
      ws.close(1008, "Max connections reached"); // 1008 = Policy Violation
      return;
    }
    
    // Reject IPs temporarily banned for repeated auth failures (issue #839)
    if (isAuthBanned(clientIp)) {
      logger.warn("Rejected connection from auth-banned IP", { ip: clientIp });
      ws.close(1008, "Too many authentication failures — try again later");
      return;
    }

    // Check connections per IP
    const ipConnections = connectionsPerIp.get(clientIp) || 0;
    if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
      logger.warn("Max connections per IP reached", { ip: clientIp, count: ipConnections });
      ws.close(1008, `Max ${MAX_CONNECTIONS_PER_IP} connections per IP`);
      return;
    }
    
    // Increment IP connection count
    connectionsPerIp.set(clientIp, ipConnections + 1);
    
    // Check for auth token in query params (optional)
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    
    // Determine if authenticated
    let authenticated = !WS_AUTH_REQUIRED; // If auth not required, auto-authenticate
    let authenticatedSlab: string | undefined = undefined;
    
    if (WS_AUTH_REQUIRED && token) {
      const tokenVerification = verifyWsToken(token);
      authenticated = tokenVerification.isValid;
      authenticatedSlab = tokenVerification.slabAddress || undefined;
      
      if (!authenticated) {
        logger.warn("Invalid WS auth token provided", { ip: clientIp });
      } else if (authenticatedSlab) {
        logger.info("Client authenticated with slab binding", { ip: clientIp, slab: authenticatedSlab });
      }
    }

    // H2: No default "*" subscription — clients must explicitly subscribe
    const client: WsClient = { 
      ws, 
      subscriptions: new Set(), 
      isAlive: true,
      authenticated,
      authenticatedSlab,
      ip: clientIp
    };
    clients.add(client);
    metrics.totalConnections = clients.size;
    
    logger.info("WebSocket connection established", { 
      ip: clientIp, 
      authenticated,
      totalClients: clients.size 
    });
    
    // If auth required and not authenticated, set timeout
    if (WS_AUTH_REQUIRED && !authenticated) {
      client.authTimeout = setTimeout(() => {
        if (!client.authenticated) {
          logger.warn("Client failed to authenticate within timeout", { ip: clientIp });
          // Record auth failure for rate limiting (issue #839: flood protection)
          recordAuthFailure(clientIp);
          ws.close(1008, "Authentication timeout");
        }
      }, AUTH_TIMEOUT_MS);
    }

    // BH2: Set up ping/pong heartbeat with 10s timeout
    ws.on("pong", () => {
      client.isAlive = true;
      if (client.pongTimeout) {
        clearTimeout(client.pongTimeout);
        client.pongTimeout = undefined;
      }
    });

    client.pingInterval = setInterval(() => {
      if (!client.isAlive) {
        // Client didn't respond to last ping — terminate
        logger.warn("Client failed heartbeat", { ip: client.ip });
        clearInterval(client.pingInterval);
        if (client.pongTimeout) {
          clearTimeout(client.pongTimeout);
        }
        ws.terminate();
        return;
      }
      
      client.isAlive = false;
      ws.ping();
      
      // Set timeout for pong response (10 seconds)
      client.pongTimeout = setTimeout(() => {
        if (!client.isAlive) {
          logger.warn("Pong timeout exceeded", { ip: client.ip });
          clearInterval(client.pingInterval);
          ws.terminate();
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);

    ws.send(JSON.stringify({ type: "connected", message: "Percolator WebSocket connected" }));

    ws.on("message", async (raw) => {
      try {
        const rawStr = raw.toString();
        
        // Track metrics
        metrics.messagesReceived++;
        metrics.bytesReceived += rawStr.length;
        
        // Limit message size
        if (rawStr.length > 1024) {
          ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
          return;
        }
        
        const msg = JSON.parse(rawStr) as { 
          type: string; 
          slabAddress?: string; 
          token?: string;
          channels?: string[];
        };
        
        // Handle auth message
        if (msg.type === "auth" && msg.token) {
          const tokenVerification = verifyWsToken(msg.token);
          if (tokenVerification.isValid) {
            client.authenticated = true;
            client.authenticatedSlab = tokenVerification.slabAddress || undefined;
            
            if (client.authTimeout) {
              clearTimeout(client.authTimeout);
              client.authTimeout = undefined;
            }
            
            logger.info("Client authenticated via message", { 
              ip: client.ip, 
              slab: client.authenticatedSlab 
            });
            ws.send(JSON.stringify({ 
              type: "authenticated", 
              slabBinding: client.authenticatedSlab 
            }));
          } else {
            logger.warn("Invalid auth token in message", { ip: client.ip });
            // Record auth failure for rate limiting (issue #839)
            recordAuthFailure(client.ip);
            ws.send(JSON.stringify({ type: "error", message: "Invalid authentication token" }));
          }
          return;
        }
        
        // If auth required and not authenticated, reject all other messages
        if (WS_AUTH_REQUIRED && !client.authenticated) {
          ws.send(JSON.stringify({ type: "error", message: "Authentication required" }));
          return;
        }
        
        // Handle subscribe with channels array
        if (msg.type === "subscribe" && msg.channels && Array.isArray(msg.channels)) {
          const subscribed: string[] = [];
          const errors: string[] = [];
          
          for (const channel of msg.channels) {
            // Validate channel format (e.g., "price:SOL", "trades:BTC")
            if (!channel.includes(":")) {
              errors.push(`Invalid channel format: ${channel}`);
              continue;
            }
            
            const [channelType, slabAddress] = channel.split(":");
            if (!["price", "trades", "funding"].includes(channelType)) {
              errors.push(`Unknown channel type: ${channelType}`);
              continue;
            }
            
            // Sanitize slab address
            const sanitized = sanitizeSlabAddress(slabAddress);
            if (!sanitized) {
              errors.push(`Invalid slab address: ${slabAddress}`);
              continue;
            }
            
            // Verify slab binding if client is authenticated with a specific slab
            if (client.authenticatedSlab && client.authenticatedSlab !== sanitized) {
              errors.push(`Token is bound to slab ${client.authenticatedSlab}, cannot subscribe to ${sanitized}`);
              logger.warn("Slab binding violation attempt", { 
                ip: client.ip, 
                authenticatedSlab: client.authenticatedSlab, 
                requestedSlab: sanitized 
              });
              continue;
            }
            
            const fullChannel = `${channelType}:${sanitized}`;
            
            // Check if already subscribed
            if (client.subscriptions.has(fullChannel)) {
              continue;
            }
            
            // Cap global subscriptions to prevent DoS
            if (globalSubscriptionCount >= MAX_GLOBAL_SUBSCRIPTIONS) {
              errors.push(`Server subscription limit reached (${MAX_GLOBAL_SUBSCRIPTIONS})`);
              break;
            }
            
            // Cap subscriptions per client
            if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
              errors.push(`Max ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per connection`);
              break;
            }
            
            // Check per-slab connection limit
            const slabClients = connectionsPerSlab.get(sanitized);
            if (slabClients && slabClients.size >= MAX_CONNECTIONS_PER_SLAB) {
              errors.push(`Max ${MAX_CONNECTIONS_PER_SLAB} connections for slab ${sanitized}`);
              continue;
            }
            
            client.subscriptions.add(fullChannel);
            globalSubscriptionCount++;
            addClientToSlab(client, sanitized);
            subscribed.push(fullChannel);
          }
          
          if (subscribed.length > 0) {
            ws.send(JSON.stringify({ type: "subscribed", channels: subscribed }));
            
            // Send initial data for price channels
            for (const channel of subscribed) {
              if (channel.startsWith("price:")) {
                const slab = channel.split(":")[1];
                try {
                  const { data: stats } = await getSupabase()
                    .from("market_stats")
                    .select("last_price, mark_price, index_price, updated_at")
                    .eq("slab_address", slab)
                    .single();

                  if (stats && stats.last_price) {
                    if (ws.bufferedAmount <= MAX_BUFFER_BYTES) {
                      ws.send(
                        JSON.stringify({
                          type: "price",
                          slab,
                          price: stats.last_price / 1_000_000,
                          markPrice: stats.mark_price ? stats.mark_price / 1_000_000 : undefined,
                          indexPrice: stats.index_price ? stats.index_price / 1_000_000 : undefined,
                          timestamp: stats.updated_at,
                        }),
                      );
                    }
                  }
                } catch {
                  // Ignore errors fetching initial price
                }
              }
            }
          }
          
          if (errors.length > 0) {
            ws.send(JSON.stringify({ type: "error", message: errors.join("; ") }));
          }
        }
        // Legacy: single slab subscription (backward compatibility)
        else if (msg.type === "subscribe" && msg.slabAddress) {
          const sanitized = sanitizeSlabAddress(msg.slabAddress);
          if (!sanitized) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid slab address" }));
            return;
          }
          
          // Verify slab binding if client is authenticated with a specific slab
          if (client.authenticatedSlab && client.authenticatedSlab !== sanitized) {
            logger.warn("Slab binding violation attempt (legacy)", { 
              ip: client.ip, 
              authenticatedSlab: client.authenticatedSlab, 
              requestedSlab: sanitized 
            });
            ws.send(JSON.stringify({ 
              type: "error", 
              message: `Token is bound to slab ${client.authenticatedSlab}, cannot subscribe to ${sanitized}` 
            }));
            return;
          }
          
          // Subscribe to all channels for this slab (backward compatibility)
          const channels = [`price:${sanitized}`, `trades:${sanitized}`, `funding:${sanitized}`];
          ws.send(JSON.stringify({ 
            type: "info", 
            message: "Please use channels array. Subscribing to all channels for this slab." 
          }));
          
          // Simulate channels subscription
          for (const channel of channels) {
            if (client.subscriptions.has(channel)) continue;
            if (globalSubscriptionCount >= MAX_GLOBAL_SUBSCRIPTIONS) break;
            if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) break;
            
            client.subscriptions.add(channel);
            globalSubscriptionCount++;
          }
          
          addClientToSlab(client, sanitized);
          ws.send(JSON.stringify({ type: "subscribed", slabAddress: sanitized, channels }));
        }
        // Handle unsubscribe with channels array
        else if (msg.type === "unsubscribe" && msg.channels && Array.isArray(msg.channels)) {
          const unsubscribed: string[] = [];
          
          for (const channel of msg.channels) {
            if (client.subscriptions.delete(channel)) {
              globalSubscriptionCount--;
              unsubscribed.push(channel);
              
              // Extract slab and remove from slab tracking if no more subs for this slab
              const slab = extractSlabFromChannel(channel);
              if (slab) {
                const stillHasSlab = Array.from(client.subscriptions).some(
                  ch => extractSlabFromChannel(ch) === slab
                );
                if (!stillHasSlab) {
                  removeClientFromSlab(client, slab);
                }
              }
            }
          }
          
          if (unsubscribed.length > 0) {
            ws.send(JSON.stringify({ type: "unsubscribed", channels: unsubscribed }));
          }
        }
        // Legacy: single slab unsubscribe
        else if (msg.type === "unsubscribe" && msg.slabAddress) {
          const sanitized = sanitizeSlabAddress(msg.slabAddress);
          if (sanitized) {
            const channels = [`price:${sanitized}`, `trades:${sanitized}`, `funding:${sanitized}`];
            const unsubscribed: string[] = [];
            
            for (const channel of channels) {
              if (client.subscriptions.delete(channel)) {
                globalSubscriptionCount--;
                unsubscribed.push(channel);
              }
            }
            
            removeClientFromSlab(client, sanitized);
            ws.send(JSON.stringify({ type: "unsubscribed", slabAddress: sanitized, channels: unsubscribed }));
          }
        }
      } catch (err) {
        logger.warn("Error processing WS message", { ip: client.ip, error: err });
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      // BH2: Clean up heartbeat interval
      if (client.pingInterval) {
        clearInterval(client.pingInterval);
      }
      
      // Clean up pong timeout
      if (client.pongTimeout) {
        clearTimeout(client.pongTimeout);
      }
      
      // Clean up auth timeout
      if (client.authTimeout) {
        clearTimeout(client.authTimeout);
      }
      
      // Decrement IP connection count
      const ipCount = connectionsPerIp.get(client.ip) || 1;
      if (ipCount <= 1) {
        connectionsPerIp.delete(client.ip);
      } else {
        connectionsPerIp.set(client.ip, ipCount - 1);
      }
      
      // Remove from slab tracking
      const clientSlabs = getClientSlabs(client);
      for (const slab of clientSlabs) {
        removeClientFromSlab(client, slab);
      }
      
      // H2: O(1) removal with Set
      // Decrement global subscription count for all client subscriptions
      globalSubscriptionCount -= client.subscriptions.size;
      clients.delete(client);
      metrics.totalConnections = clients.size;
      
      logger.info("WebSocket connection closed", { 
        ip: client.ip, 
        totalClients: clients.size 
      });
    });
  });

  return wss;
}
