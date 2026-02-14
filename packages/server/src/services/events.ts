import { EventEmitter } from "node:events";

export type ServerEvent =
  | "market.creating"
  | "market.created"
  | "market.updated"
  | "price.updated"
  | "crank.success"
  | "crank.failure"
  | "crank.stale"
  | "trade.executed"
  | "position.liquidated"
  | "liquidation.success"
  | "liquidation.failure"
  | "price.engine.degraded"
  | "price.engine.recovered";

export interface EventPayload {
  event: ServerEvent;
  slabAddress: string;
  timestamp: number;
  data: Record<string, unknown>;
}

class ServerEventBus extends EventEmitter {
  // BM4: Track subscriptions to prevent listener leaks
  private subscriptions = new Map<string, number>();

  publish(event: ServerEvent, slabAddress: string, data: Record<string, unknown> = {}): void {
    const payload: EventPayload = {
      event,
      slabAddress,
      timestamp: Date.now(),
      data,
    };
    this.emit(event, payload);
    this.emit("*", payload);
  }

  subscribe(event: ServerEvent | "*", listener: (payload: EventPayload) => void): () => void {
    this.on(event, listener);
    
    // Track subscription count
    const key = event;
    this.subscriptions.set(key, (this.subscriptions.get(key) ?? 0) + 1);
    
    // Return unsubscribe function
    return () => {
      this.off(event, listener);
      const count = this.subscriptions.get(key) ?? 0;
      if (count > 0) {
        this.subscriptions.set(key, count - 1);
      }
    };
  }

  getSubscriptionCount(event: ServerEvent | "*"): number {
    return this.subscriptions.get(event) ?? 0;
  }
}

export const eventBus = new ServerEventBus();
// H7: Increase max listeners to handle many markets
// BM4: Set max to prevent unchecked listener growth
eventBus.setMaxListeners(100);
