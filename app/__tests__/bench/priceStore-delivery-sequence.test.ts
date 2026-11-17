/**
 * Delivery-sequence pin for priceStore: for 10 seeded random runs the full ordered sequence of
 * (market, listener, snapshot) deliveries must be identical across refactors. Set PS_LOG_DIR to dump
 * each run's log to disk so two revisions can be compared byte-for-byte (cmp).
 * Also asserts the no-op invariant: every delivery differs from the previous one for that market.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

describe("priceStore delivery sequence", () => {
  for (let seed = 1; seed <= 10; seed++) {
    it(`seed ${seed}: deterministic, no no-op deliveries`, () => {
      const a = runWorkload(store, { seed, markets: 60, subscribers: 5, updates: 6_000, prefix: `d${seed}`, record: true });
      expect(a.calls).toBeGreaterThan(0);
      // listener 0's view is the per-market sequence of snapshots: consecutive ones must differ.
      const last = new Map<string, string>();
      for (const line of a.log) {
        const i = line.indexOf("|");
        const j = line.indexOf("|", i + 1);
        if (line.slice(i + 1, j) !== "0") continue;
        const slab = line.slice(0, i);
        const snap = line.slice(j + 1);
        expect(last.get(slab)).not.toBe(snap);
        last.set(slab, snap);
      }
      const dir = process.env.PS_LOG_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `seed-${seed}.log`), a.log.join("\n"));
      }
    });
  }
});
