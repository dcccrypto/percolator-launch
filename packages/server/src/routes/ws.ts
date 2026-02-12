import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { OracleService } from "../services/oracle.js";
import type { PriceEngine } from "../services/PriceEngine.js";
import { eventBus } from "../services/events.js";

// H2: Configurable limits
const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS ?? 500);
const MAX_BUFFER_BYTES = 64 * 1024; // 64KB
const MAX_SUBSCRIPTIONS_PER_CLIENT = 50; // Prevent Helius WS subscription exhaustion
const MAX_GLOBAL_SUBSCRIPTIONS = 1000; // Global subscription cap to prevent DoS

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>;
  pingInterval?: ReturnType<typeof setInterval>; // BH2: Heartbeat timer
  isAlive: boolean; // BH2: Track pong responses
}

// Track global subscription count across all clients
let globalSubscriptionCount = 0;

// BH2: Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

export function setupWebSocket(
  server: Server,
  oracleService: OracleService,
  priceEngine?: PriceEngine,
): WebSocketServer {
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  // H2: Use Set for O(1) removal
  const clients = new Set<WsClient>();

  // Broadcast price updates to subscribed clients
  eventBus.on("price.updated", (payload: any) => {
    const msg = JSON.stringify({
      type: "price.updated",
      slabAddress: payload.slabAddress,
      data: payload.data,
      timestamp: payload.timestamp,
    });

    for (const client of clients) {
      if (
        client.ws.readyState === WebSocket.OPEN &&
        client.subscriptions.has(payload.slabAddress) // H2: removed default "*" — must explicitly subscribe
      ) {
        // H2: Check bufferedAmount before sending
        if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) continue;
        client.ws.send(msg);
      }
    }
  });

  wss.on("connection", (ws) => {
    // H2: Reject if at max connections
    if (clients.size >= MAX_WS_CONNECTIONS) {
      ws.close(1013, "Max connections reached");
      return;
    }

    // H2: No default "*" subscription — clients must explicitly subscribe
    const client: WsClient = { ws, subscriptions: new Set(), isAlive: true };
    clients.add(client);

    // BH2: Set up ping/pong heartbeat
    ws.on("pong", () => {
      client.isAlive = true;
    });

    client.pingInterval = setInterval(() => {
      if (!client.isAlive) {
        // Client didn't respond to last ping — terminate
        clearInterval(client.pingInterval);
        ws.terminate();
        return;
      }
      client.isAlive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    ws.send(JSON.stringify({ type: "connected", message: "Percolator WebSocket connected" }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; slabAddress?: string };
        if (msg.type === "subscribe" && msg.slabAddress) {
          // Cap global subscriptions to prevent DoS
          if (globalSubscriptionCount >= MAX_GLOBAL_SUBSCRIPTIONS) {
            ws.send(JSON.stringify({ type: "error", message: `Server subscription limit reached (${MAX_GLOBAL_SUBSCRIPTIONS})` }));
            return;
          }
          
          // Cap subscriptions per client to prevent Helius WS exhaustion
          if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
            ws.send(JSON.stringify({ type: "error", message: `Max ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per connection` }));
            return;
          }
          
          client.subscriptions.add(msg.slabAddress);
          globalSubscriptionCount++;

          if (priceEngine) {
            priceEngine.subscribeToSlab(msg.slabAddress);
          }

          ws.send(JSON.stringify({ type: "subscribed", slabAddress: msg.slabAddress }));

          // Send current price if available
          const enginePrice = priceEngine?.getLatestPrice(msg.slabAddress);
          const oraclePrice = oracleService.getCurrentPrice(msg.slabAddress);
          const price = enginePrice ?? oraclePrice;
          if (price) {
            // H2: Check buffer before sending
            if (ws.bufferedAmount <= MAX_BUFFER_BYTES) {
              ws.send(
                JSON.stringify({
                  type: "price.updated",
                  slabAddress: msg.slabAddress,
                  data: { priceE6: price.priceE6.toString(), source: price.source },
                  timestamp: price.timestamp,
                }),
              );
            }
          }
        } else if (msg.type === "unsubscribe" && msg.slabAddress) {
          if (client.subscriptions.delete(msg.slabAddress)) {
            globalSubscriptionCount--;
          }
          ws.send(JSON.stringify({ type: "unsubscribed", slabAddress: msg.slabAddress }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      // BH2: Clean up heartbeat interval
      if (client.pingInterval) {
        clearInterval(client.pingInterval);
      }
      // H2: O(1) removal with Set
      // Decrement global subscription count for all client subscriptions
      globalSubscriptionCount -= client.subscriptions.size;
      clients.delete(client);
    });
  });

  return wss;
}
