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
  | "liquidation.failure";

export interface EventPayload {
  event: ServerEvent;
  slabAddress: string;
  timestamp: number;
  data: Record<string, unknown>;
}

class ServerEventBus extends EventEmitter {
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
}

export const eventBus = new ServerEventBus();
// H7: Increase max listeners to handle many markets
eventBus.setMaxListeners(100);
