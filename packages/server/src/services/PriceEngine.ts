import WebSocket from "ws";
import { parseConfig, type MarketConfig } from "@percolator/core";
import { config } from "../config.js";
import { eventBus } from "./events.js";

// BL2: Extract magic numbers to named constants
const PENDING_SUB_CLEANUP_INTERVAL_MS = 60_000; // Clean stale subscriptions every 60s
const PENDING_SUB_MAX_AGE_MS = 60_000; // Stale subscription age threshold (60s)

interface PriceTick {
  priceE6: bigint;
  source: string;
  timestamp: number;
}

interface MarketStats {
  high24h: bigint;
  low24h: bigint;
  open24h: bigint;
  current: bigint;
}

/**
 * Real-time price engine using Helius Enhanced WebSocket.
 * Subscribes to slab account changes and parses oracle prices from on-chain data.
 */
export class PriceEngine {
  private ws: WebSocket | null = null;
  private subscriptionIds = new Map<number, string>(); // subId -> slabAddress
  private slabToSubId = new Map<string, number>();
  private priceHistory = new Map<string, PriceTick[]>();
  private readonly maxHistory = 100;
  private readonly maxTrackedMarkets = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = PENDING_SUB_MAX_AGE_MS;
  // BM6: Limit rapid reconnection attempts (circuit breaker pattern)
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  // Self-healing: after exhausting rapid retries, enter cooldown then retry indefinitely
  private readonly cooldownIntervalMs = 5 * 60_000; // 5 minutes between recovery attempts
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private inCooldown = false;
  private rpcMsgId = 1;
  private started = false;
  private pendingSubscriptions: string[] = [];
  private pendingCleanupTimer: ReturnType<typeof setInterval> | null = null;

  private get wsUrl(): string {
    return config.rpcUrl.replace("https://", "wss://");
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();

    // Periodically clean up stale pending subscription responses (older than 30s)
    this.pendingCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - PENDING_SUB_MAX_AGE_MS;
      for (const [msgId, entry] of this._pendingSubResponses) {
        if (entry.timestamp < cutoff) {
          this._pendingSubResponses.delete(msgId);
        }
      }
    }, PENDING_SUB_CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    this.started = false;
    this.inCooldown = false;
    if (this.pendingCleanupTimer) {
      clearInterval(this.pendingCleanupTimer);
      this.pendingCleanupTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Check if the engine is alive and serving prices */
  isHealthy(): boolean {
    return this.started && !this.inCooldown && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Subscribe to a slab account for real-time price updates.
   */
  subscribeToSlab(slabAddress: string): void {
    if (this.slabToSubId.has(slabAddress)) return;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingSubscriptions.push(slabAddress);
      // Trigger connection if not already connecting
      if (!this.ws) this.connect();
      return;
    }

    this.sendSubscribe(slabAddress);
  }

  /**
   * Unsubscribe from a slab account.
   */
  unsubscribeFromSlab(slabAddress: string): void {
    const subId = this.slabToSubId.get(slabAddress);
    if (subId === undefined || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msgId = this.rpcMsgId++;
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: msgId,
      method: "accountUnsubscribe",
      params: [subId],
    }));

    this.subscriptionIds.delete(subId);
    this.slabToSubId.delete(slabAddress);
  }

  /**
   * Get latest price for a slab.
   */
  getLatestPrice(slabAddress: string): PriceTick | null {
    const history = this.priceHistory.get(slabAddress);
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  /**
   * Get all latest prices across all subscribed markets.
   */
  getAllPrices(): Record<string, PriceTick> {
    const result: Record<string, PriceTick> = {};
    for (const [slab, history] of this.priceHistory) {
      if (history.length > 0) {
        result[slab] = history[history.length - 1];
      }
    }
    return result;
  }

  /**
   * Get price history (last N ticks) for a slab.
   */
  getHistory(slabAddress: string): PriceTick[] {
    return this.priceHistory.get(slabAddress) ?? [];
  }

  /**
   * Get 24h stats for a slab.
   */
  get24hStats(slabAddress: string): MarketStats | null {
    const history = this.priceHistory.get(slabAddress);
    if (!history || history.length === 0) return null;

    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const recent = history.filter((t) => t.timestamp >= cutoff);

    if (recent.length === 0) {
      // Use all available history
      const current = history[history.length - 1].priceE6;
      let high = current;
      let low = current;
      for (const tick of history) {
        if (tick.priceE6 > high) high = tick.priceE6;
        if (tick.priceE6 < low) low = tick.priceE6;
      }
      return { high24h: high, low24h: low, open24h: history[0].priceE6, current };
    }

    const current = recent[recent.length - 1].priceE6;
    let high = current;
    let low = current;
    for (const tick of recent) {
      if (tick.priceE6 > high) high = tick.priceE6;
      if (tick.priceE6 < low) low = tick.priceE6;
    }
    return { high24h: high, low24h: low, open24h: recent[0].priceE6, current };
  }

  // ─── Private ───

  private connect(): void {
    if (!this.started) return;

    // Don't connect if nothing to subscribe to — avoids idle connection flapping
    if (this.slabToSubId.size === 0 && this.pendingSubscriptions.length === 0) {
      return;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      console.error("[PriceEngine] Failed to create WebSocket:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[PriceEngine] Connected to Helius WebSocket");
      this.reconnectDelay = 1000;
      // BM6: Reset reconnect attempt counter on successful connection
      this.reconnectAttempts = 0;
      // Self-healing: if we recovered from cooldown, log and reset
      if (this.inCooldown) {
        console.log("[PriceEngine] Recovered from dormant cooldown — price streaming restored");
        this.inCooldown = false;
        eventBus.publish("price.engine.recovered", "system", {});
      }

      // Clear stale subscription mappings from previous connection
      const existingSlabs = [...this.slabToSubId.keys()];
      this.subscriptionIds.clear();
      this.slabToSubId.clear();
      this._pendingSubResponses.clear();

      // Re-subscribe existing slabs
      for (const slabAddress of existingSlabs) {
        this.sendSubscribe(slabAddress);
      }

      // Subscribe pending
      while (this.pendingSubscriptions.length > 0) {
        const slab = this.pendingSubscriptions.pop()!;
        if (!this.slabToSubId.has(slab)) {
          this.sendSubscribe(slab);
        }
      }
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      console.warn("[PriceEngine] WebSocket closed");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[PriceEngine] Failed to maintain WebSocket connection:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer || this.cooldownTimer) return;
    
    // BM6: After exhausting rapid retries, enter cooldown mode instead of dying
    this.reconnectAttempts++;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (!this.inCooldown) {
        console.error(
          `[PriceEngine] Max rapid reconnect attempts (${this.maxReconnectAttempts}) exhausted. ` +
          `Entering cooldown — will retry every ${this.cooldownIntervalMs / 1000}s.`
        );
        this.inCooldown = true;
        eventBus.publish("price.engine.degraded", "system", {
          reason: "max_reconnect_exhausted",
          cooldownMs: this.cooldownIntervalMs,
        });
      }
      // Dormant recovery: retry at a much slower cadence instead of stopping
      this.cooldownTimer = setTimeout(() => {
        this.cooldownTimer = null;
        this.reconnectAttempts = this.maxReconnectAttempts - 1; // Allow one rapid attempt
        this.reconnectDelay = 1000;
        console.log("[PriceEngine] Cooldown recovery attempt...");
        this.connect();
      }, this.cooldownIntervalMs);
      return;
    }
    
    console.log(`[PriceEngine] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private sendSubscribe(slabAddress: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msgId = this.rpcMsgId++;
    // Store pending mapping: msgId -> slabAddress (resolved in handleMessage)
    this._pendingSubResponses.set(msgId, { slabAddress, timestamp: Date.now() });

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: msgId,
      method: "accountSubscribe",
      params: [
        slabAddress,
        { encoding: "base64", commitment: "confirmed" },
      ],
    }));
  }

  private _pendingSubResponses = new Map<number, { slabAddress: string; timestamp: number }>();

  private handleMessage(msg: Record<string, unknown>): void {
    // Subscription error response: { id, error: {...} }
    if (msg.id !== undefined && msg.error !== undefined) {
      const msgId = msg.id as number;
      const pending = this._pendingSubResponses.get(msgId);
      if (pending) {
        this._pendingSubResponses.delete(msgId);
        console.error(`[PriceEngine] Subscription failed for ${pending.slabAddress}:`, msg.error);
      }
      return;
    }

    // Subscription response: { id, result: subscriptionId }
    if (msg.id !== undefined && msg.result !== undefined) {
      const msgId = msg.id as number;
      const subId = msg.result as number;
      const pending = this._pendingSubResponses.get(msgId);
      if (pending) {
        this._pendingSubResponses.delete(msgId);
        this.subscriptionIds.set(subId, pending.slabAddress);
        this.slabToSubId.set(pending.slabAddress, subId);
        console.log(`[PriceEngine] Subscribed to ${pending.slabAddress} (sub=${subId})`);
      }
      return;
    }

    // Account notification: { method: "accountNotification", params: { subscription, result } }
    if (msg.method === "accountNotification") {
      const params = msg.params as { subscription: number; result: { value: { data: [string, string] } } };
      const subId = params.subscription;
      const slabAddress = this.subscriptionIds.get(subId);
      if (!slabAddress) return;

      try {
        const dataArr = params.result?.value?.data;
        if (!Array.isArray(dataArr) || dataArr[1] !== "base64") return;

        const buf = Buffer.from(dataArr[0], "base64");
        const data = new Uint8Array(buf);

        // Parse MarketConfig to get authorityPriceE6
        const mktConfig = parseConfig(data);
        const priceE6 = mktConfig.authorityPriceE6;

        if (priceE6 === 0n) return; // No price set yet

        const tick: PriceTick = {
          priceE6,
          source: "helius-ws",
          timestamp: Date.now(),
        };

        this.recordTick(slabAddress, tick);

        // Broadcast via event bus
        eventBus.publish("price.updated", slabAddress, {
          priceE6: priceE6.toString(),
          source: "helius-ws",
        });
      } catch (err) {
        console.error(`[PriceEngine] Failed to parse account data for ${slabAddress}:`, err);
      }
    }
  }

  private recordTick(slabAddress: string, tick: PriceTick): void {
    let history = this.priceHistory.get(slabAddress);
    if (!history) {
      history = [];
      this.priceHistory.set(slabAddress, history);
    }
    history.push(tick);
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }
    // Evict least recently updated market if we exceed the global limit
    if (this.priceHistory.size > this.maxTrackedMarkets) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, hist] of this.priceHistory) {
        if (key === slabAddress) continue;
        const lastTs = hist.length > 0 ? hist[hist.length - 1].timestamp : 0;
        if (lastTs < oldestTime) {
          oldestTime = lastTs;
          oldestKey = key;
        }
      }
      if (oldestKey) this.priceHistory.delete(oldestKey);
    }
  }
}
