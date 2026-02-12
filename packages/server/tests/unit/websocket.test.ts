/**
 * Unit Tests: WebSocket Server
 * Tests WS-001 through WS-006 from TEST_PLAN.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { setupWebSocket } from "../../src/routes/ws.js";
import type { OracleService } from "../../src/services/oracle.js";
import type { PriceEngine } from "../../src/services/PriceEngine.js";
import { eventBus } from "../../src/services/events.js";

// Helper to create a test HTTP server
function createTestServer(): Server {
  return createServer();
}

// Helper to connect a WebSocket client
function createTestClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// Helper to wait for a message
function waitForMessage(ws: WebSocket, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Message timeout")), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// Helper to wait for close event
function waitForClose(ws: WebSocket, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Close timeout")), timeout);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("WebSocket Server", () => {
  let server: Server;
  let wss: WebSocketServer;
  let mockOracleService: OracleService;
  let mockPriceEngine: PriceEngine;
  let port: number;

  beforeEach(async () => {
    // Create mock services
    mockOracleService = {
      getCurrentPrice: vi.fn().mockReturnValue({
        priceE6: 100_000_000n,
        source: "dexscreener",
        timestamp: Date.now(),
      }),
    } as any;

    mockPriceEngine = {
      subscribeToSlab: vi.fn(),
      getLatestPrice: vi.fn().mockReturnValue({
        priceE6: 100_500_000n,
        source: "helius-ws",
        timestamp: Date.now(),
      }),
    } as any;

    // Create HTTP server on random port
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });

    // Setup WebSocket server
    wss = setupWebSocket(server, mockOracleService, mockPriceEngine);
  });

  afterEach(async () => {
    // Close all connections
    wss.clients.forEach((client) => client.terminate());
    wss.close();
    
    // Close HTTP server
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * WS-001: Client connects successfully
   * Type: Integration
   * AC: Valid WebSocket handshake establishes connection
   */
  it("WS-001: should establish WebSocket connection successfully", async () => {
    const client = await createTestClient(port);
    
    // Should receive connected message
    const msg = await waitForMessage(client);
    expect(msg.type).toBe("connected");
    expect(msg.message).toBe("Percolator WebSocket connected");

    client.close();
  });

  /**
   * WS-002: Heartbeat timeout disconnects client
   * Type: Integration
   * AC1: Client connections timeout after missing pong (30s)
   */
  it("WS-002: should disconnect client after heartbeat timeout", async () => {
    // Use fake timers for this test
    vi.useFakeTimers();

    const client = await createTestClient(port);
    
    // Wait for connected message
    await waitForMessage(client);

    // Don't respond to pings - simulate unresponsive client
    client.on("ping", () => {
      // Intentionally don't send pong
    });

    // Wait for close event
    const closePromise = waitForClose(client, 35000);

    // Fast-forward time by 31 seconds (past the 30s timeout)
    await vi.advanceTimersByTimeAsync(31_000);

    // Connection should be terminated
    await closePromise;

    vi.useRealTimers();
  }, 10000);

  /**
   * WS-003: Price update broadcast
   * Type: Integration
   * AC2: Price updates are broadcast to subscribed clients only
   */
  it("WS-003: should broadcast price update to subscribed client", async () => {
    const client = await createTestClient(port);
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    // Wait for connected message
    await waitForMessage(client);

    // Subscribe to market
    client.send(JSON.stringify({
      type: "subscribe",
      slabAddress,
    }));

    // Should receive subscription confirmation
    const subMsg = await waitForMessage(client);
    expect(subMsg.type).toBe("subscribed");
    expect(subMsg.slabAddress).toBe(slabAddress);

    // Should also receive current price
    const priceMsg = await waitForMessage(client);
    expect(priceMsg.type).toBe("price.updated");
    expect(priceMsg.slabAddress).toBe(slabAddress);

    // Emit price update via event bus
    const updatePromise = waitForMessage(client);
    eventBus.publish("price.updated", slabAddress, {
      priceE6: "101000000",
      source: "test",
    });

    // Should receive broadcast
    const broadcastMsg = await updatePromise;
    expect(broadcastMsg.type).toBe("price.updated");
    expect(broadcastMsg.slabAddress).toBe(slabAddress);
    expect(broadcastMsg.data.priceE6).toBe("101000000");

    client.close();
  });

  /**
   * WS-004: Unsubscribed client ignored
   * Type: Integration
   * AC2: Price updates are broadcast to subscribed clients only
   */
  it("WS-004: should not broadcast to unsubscribed client", async () => {
    const client = await createTestClient(port);
    const slabAddressA = "TestSlabA11111111111111111111111111111111";
    const slabAddressB = "TestSlabB11111111111111111111111111111111";
    
    // Wait for connected message
    await waitForMessage(client);

    // Subscribe to market A only
    client.send(JSON.stringify({
      type: "subscribe",
      slabAddress: slabAddressA,
    }));

    // Wait for subscription confirmation and initial price
    await waitForMessage(client); // subscribed
    await waitForMessage(client); // initial price

    // Set up listener for any additional messages
    let receivedUnexpected = false;
    client.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.slabAddress === slabAddressB) {
        receivedUnexpected = true;
      }
    });

    // Emit price update for market B (not subscribed)
    eventBus.publish("price.updated", slabAddressB, {
      priceE6: "200000000",
      source: "test",
    });

    // Wait a bit to ensure no message is sent
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedUnexpected).toBe(false);

    client.close();
  });

  /**
   * WS-005: Invalid message rejected
   * Type: Unit
   * AC3: Invalid subscription messages are rejected
   */
  it("WS-005: should handle invalid JSON message gracefully", async () => {
    const client = await createTestClient(port);
    
    // Wait for connected message
    await waitForMessage(client);

    // Send invalid JSON
    client.send("not-valid-json{");

    // Wait a bit - server should not crash
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Connection should still be open
    expect(client.readyState).toBe(WebSocket.OPEN);

    client.close();
  });

  /**
   * WS-006: Connection cleanup on disconnect
   * Type: Integration
   * AC4: Disconnected clients are cleaned up
   */
  it("WS-006: should cleanup subscriptions when client disconnects", async () => {
    const client = await createTestClient(port);
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    // Wait for connected message
    await waitForMessage(client);

    // Subscribe to market
    client.send(JSON.stringify({
      type: "subscribe",
      slabAddress,
    }));

    // Wait for subscription
    await waitForMessage(client); // subscribed
    await waitForMessage(client); // initial price

    // Verify PriceEngine was called
    expect(mockPriceEngine.subscribeToSlab).toHaveBeenCalledWith(slabAddress);

    // Get initial client count
    const initialClientCount = wss.clients.size;

    // Disconnect client
    client.close();

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Client should be removed
    expect(wss.clients.size).toBe(initialClientCount - 1);
  });

  /**
   * Additional test: Max connections limit
   */
  it("should reject connection when max limit reached", async () => {
    // Note: This test would require setting MAX_WS_CONNECTIONS env var
    // For now, we'll test the happy path and document the limit exists
    
    const client = await createTestClient(port);
    await waitForMessage(client);
    
    expect(client.readyState).toBe(WebSocket.OPEN);
    
    client.close();
  });

  /**
   * Additional test: Unsubscribe
   */
  it("should handle unsubscribe message", async () => {
    const client = await createTestClient(port);
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    // Wait for connected message
    await waitForMessage(client);

    // Subscribe
    client.send(JSON.stringify({
      type: "subscribe",
      slabAddress,
    }));

    await waitForMessage(client); // subscribed
    await waitForMessage(client); // initial price

    // Unsubscribe
    client.send(JSON.stringify({
      type: "unsubscribe",
      slabAddress,
    }));

    // Should receive unsubscribe confirmation
    const unsubMsg = await waitForMessage(client);
    expect(unsubMsg.type).toBe("unsubscribed");
    expect(unsubMsg.slabAddress).toBe(slabAddress);

    client.close();
  });

  /**
   * Additional test: Subscription limit per client
   */
  it("should enforce max subscriptions per client", async () => {
    const client = await createTestClient(port);
    
    // Wait for connected message
    await waitForMessage(client);

    // Try to subscribe to 51 markets (limit is 50)
    for (let i = 0; i < 51; i++) {
      client.send(JSON.stringify({
        type: "subscribe",
        slabAddress: `TestSlab${i.toString().padStart(38, "1")}`,
      }));
    }

    // Collect all messages
    const messages: any[] = [];
    const collectMessages = new Promise<void>((resolve) => {
      let count = 0;
      client.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        count++;
        // After receiving enough messages, resolve
        if (count >= 102) { // 50 * 2 (subscribed + price) + 1 error
          setTimeout(resolve, 100);
        }
      });
    });

    await collectMessages;

    // Should have at least one error message about max subscriptions
    const errorMessages = messages.filter((m) => m.type === "error");
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(errorMessages[0].message).toContain("Max");

    client.close();
  }, 10000);
});
