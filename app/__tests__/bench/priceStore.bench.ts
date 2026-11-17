import { bench, describe, vi } from "vitest";

vi.mock("@/lib/priceStore/wsManager", async () => {
  const { messageListeners } = await import("./priceStoreWorkload");
  return {
    getWsManager: () => ({
      subscribeChannel: () => () => {},
      onMessage: () => () => {},
      onMessageForChannel: (channel: string, l: (data: unknown) => void) => {
        messageListeners.set(channel, l);
        return () => {};
      },
      onStatusChange: () => () => {},
    }),
  };
});

import * as store from "@/lib/priceStore/priceStore";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";
import { runWorkload } from "./priceStoreWorkload";

__setUnknownLotExpForTest(0);
let iter = 0;
let lastCalls = 0;

describe("priceStore 200 markets x 20 subscribers x 50k updates", () => {
  bench(
    "workload",
    () => {
      lastCalls = runWorkload(store, {
        seed: 1,
        markets: 200,
        subscribers: 20,
        updates: 50_000,
        prefix: `b${iter++}`,
        record: false,
      }).calls;
    },
    { iterations: 5, warmupIterations: 1, time: 0 },
  );
});

import { afterAll } from "vitest";
afterAll(() => {
  console.log(`SUBSCRIBER_CALLS=${lastCalls}`);
});
