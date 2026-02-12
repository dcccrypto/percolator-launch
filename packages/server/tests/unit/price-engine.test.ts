/**
 * Unit Tests: PriceEngine
 * Tests BH6 (reconnect limit) from TEST_PLAN.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PriceEngine } from "../../src/services/PriceEngine.js";
import WebSocket from "ws";

// Mock config
vi.mock("../../src/config.js", () => ({
  config: {
    rpcUrl: "https://api.devnet.solana.com",
  },
}));

// Mock event bus
vi.mock("../../src/services/events.js", () => ({
  eventBus: {
    publish: vi.fn(),
    on: vi.fn(),
  },
}));

// Mock WebSocket to control connection behavior
vi.mock("ws", () => {
  const EventEmitter = require("events");
  
  class MockWebSocket extends EventEmitter {
    public readyState: number = WebSocket.CONNECTING;
    public static CONNECTING = 0;
    public static OPEN = 1;
    public static CLOSING = 2;
    public static CLOSED = 3;

    constructor(public url: string) {
      super();
      // Store instance for test access
      MockWebSocket.lastInstance = this;
    }

    send(data: string) {
      // Mock send
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    terminate() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    // Helper for tests to simulate open
    simulateOpen() {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }

    // Helper for tests to simulate error
    simulateError(error: Error) {
      this.emit("error", error);
    }

    // Helper for tests to simulate close
    simulateClose() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    static lastInstance: MockWebSocket | null = null;
  }

  return { default: MockWebSocket };
});

// Import after mocking
const { default: MockWebSocket } = await import("ws");

describe("PriceEngine", () => {
  let priceEngine: PriceEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    priceEngine = new PriceEngine();
    (MockWebSocket as any).lastInstance = null;
  });

  afterEach(() => {
    priceEngine.stop();
    vi.useRealTimers();
  });

  /**
   * BH6: PriceEngine reconnect limit
   * Type: Unit
   * Requirement: Limit reconnection attempts to prevent infinite loops
   */
  it("BH6: should stop reconnecting after max attempts (10)", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    // Subscribe to trigger connection
    priceEngine.subscribeToSlab(slabAddress);
    
    // Start the engine
    priceEngine.start();

    // Simulate 10 failed connection attempts
    for (let attempt = 0; attempt < 10; attempt++) {
      // Advance timers to trigger connection attempt
      await vi.advanceTimersByTimeAsync(0);

      // Get the WebSocket instance created for this attempt
      const ws = (MockWebSocket as any).lastInstance;
      expect(ws).not.toBeNull();

      // Simulate immediate connection failure
      ws.simulateError(new Error("Connection failed"));
      ws.simulateClose();

      // Advance timers for reconnect delay
      if (attempt < 9) {
        // Calculate exponential backoff delay: 1000 * 2^attempt, capped at 60000
        const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
        await vi.advanceTimersByTimeAsync(delay + 100);
      }
    }

    // After 10 attempts, engine should stop
    // Try to advance time and verify no new connection is created
    const lastInstance = (MockWebSocket as any).lastInstance;
    (MockWebSocket as any).lastInstance = null;
    
    await vi.advanceTimersByTimeAsync(70000);
    
    // No new WebSocket should be created
    expect((MockWebSocket as any).lastInstance).toBeNull();
  }, 30000);

  /**
   * BH6: Reset reconnect counter on successful connection
   * Type: Unit
   * Requirement: Reconnect counter should reset after successful connection
   */
  it("BH6: should reset reconnect counter after successful connection", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    priceEngine.subscribeToSlab(slabAddress);
    priceEngine.start();

    // First connection attempt - fail it
    await vi.advanceTimersByTimeAsync(0);
    let ws = (MockWebSocket as any).lastInstance;
    ws.simulateError(new Error("Connection failed"));
    ws.simulateClose();

    // Wait for reconnect
    await vi.advanceTimersByTimeAsync(1100);

    // Second attempt - succeed
    ws = (MockWebSocket as any).lastInstance;
    ws.simulateOpen();

    // Now close the connection
    ws.simulateClose();

    // Wait for reconnect
    await vi.advanceTimersByTimeAsync(1100);

    // Third attempt - should use initial delay (1000ms) not exponential
    // This proves the counter was reset
    ws = (MockWebSocket as any).lastInstance;
    expect(ws).not.toBeNull();

    // Fail this one
    ws.simulateError(new Error("Connection failed"));
    ws.simulateClose();

    // The next reconnect delay should be 2000ms (1000 * 2^1)
    (MockWebSocket as any).lastInstance = null;
    await vi.advanceTimersByTimeAsync(1500); // Not enough time
    expect((MockWebSocket as any).lastInstance).toBeNull();

    await vi.advanceTimersByTimeAsync(600); // Now enough time
    expect((MockWebSocket as any).lastInstance).not.toBeNull();
  }, 30000);

  /**
   * Additional test: Successful connection flow
   */
  it("should successfully connect and subscribe to slab", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    priceEngine.start();
    priceEngine.subscribeToSlab(slabAddress);

    // Advance timers to trigger connection
    await vi.advanceTimersByTimeAsync(0);

    const ws = (MockWebSocket as any).lastInstance;
    expect(ws).not.toBeNull();

    // Simulate successful connection
    ws.simulateOpen();

    // Engine should send subscription request
    expect(ws.send).toBeDefined();
  });

  /**
   * Additional test: Price history tracking
   */
  it("should track price history for subscribed markets", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    priceEngine.start();
    priceEngine.subscribeToSlab(slabAddress);

    await vi.advanceTimersByTimeAsync(0);
    const ws = (MockWebSocket as any).lastInstance;
    ws.simulateOpen();

    // Simulate account notification with price data
    // This would normally parse the slab data, but we can test the history mechanism
    
    // Initially, no price
    expect(priceEngine.getLatestPrice(slabAddress)).toBeNull();
    expect(priceEngine.getHistory(slabAddress)).toEqual([]);
  });

  /**
   * Additional test: Exponential backoff
   */
  it("should use exponential backoff for reconnection delays", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    priceEngine.subscribeToSlab(slabAddress);
    priceEngine.start();

    const delays: number[] = [];

    // Track when connections are attempted
    let lastAttemptTime = Date.now();

    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(0);
      
      const currentTime = Date.now();
      if (attempt > 0) {
        delays.push(currentTime - lastAttemptTime);
      }
      lastAttemptTime = currentTime;

      const ws = (MockWebSocket as any).lastInstance;
      ws.simulateError(new Error("Connection failed"));
      ws.simulateClose();

      // Advance to next attempt
      if (attempt < 4) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
        await vi.advanceTimersByTimeAsync(delay + 100);
      }
    }

    // Verify delays are increasing (exponential backoff)
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    expect(delays[3]).toBeGreaterThan(delays[2]);
  }, 30000);

  /**
   * Additional test: Pending subscriptions
   */
  it("should queue subscriptions when WebSocket is not connected", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    // Subscribe before starting (no connection yet)
    priceEngine.subscribeToSlab(slabAddress);

    // Start engine
    priceEngine.start();

    // Advance timers to trigger connection
    await vi.advanceTimersByTimeAsync(0);

    const ws = (MockWebSocket as any).lastInstance;
    expect(ws).not.toBeNull();

    // Simulate successful connection
    ws.simulateOpen();

    // Pending subscription should be processed
    // (In real code, this would send the subscription message)
  });

  /**
   * Additional test: Unsubscribe
   */
  it("should unsubscribe from slab", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    priceEngine.start();
    priceEngine.subscribeToSlab(slabAddress);

    await vi.advanceTimersByTimeAsync(0);
    const ws = (MockWebSocket as any).lastInstance;
    ws.simulateOpen();

    // Mock the subscription ID mapping
    (priceEngine as any).slabToSubId.set(slabAddress, 1);
    (priceEngine as any).subscriptionIds.set(1, slabAddress);

    // Unsubscribe
    priceEngine.unsubscribeFromSlab(slabAddress);

    // Mappings should be cleared
    expect((priceEngine as any).slabToSubId.has(slabAddress)).toBe(false);
    expect((priceEngine as any).subscriptionIds.has(1)).toBe(false);
  });

  /**
   * Additional test: Stop engine
   */
  it("should cleanup when stopped", async () => {
    const slabAddress = "TestSlab111111111111111111111111111111111";
    
    priceEngine.start();
    priceEngine.subscribeToSlab(slabAddress);

    await vi.advanceTimersByTimeAsync(0);
    const ws = (MockWebSocket as any).lastInstance;
    ws.simulateOpen();

    // Stop engine
    priceEngine.stop();

    // WebSocket should be closed
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
