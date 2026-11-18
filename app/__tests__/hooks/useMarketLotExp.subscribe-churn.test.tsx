/**
 * Perf: useMarketLotExp must not resubscribe on every render. Mounts 200 consumers over 50 slabs, forces 100
 * re-renders, fires 50 lot-exponent events and counts onLotExp add/remove calls plus wall time (median of 5), for the
 * pre-change implementation (kept below as `legacy*`) and the real hook. Both must return the same exponents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { act, render } from "@testing-library/react";

const counts = { add: 0, remove: 0 };
vi.mock("@/lib/v22/lot-registry", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/lot-registry")>();
  return {
    ...real,
    onLotExp: (cb: (slab: string, k: number) => void) => {
      counts.add++;
      const off = real.onLotExp(cb);
      return () => {
        counts.remove++;
        off();
      };
    },
  };
});

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, ensureLotExp, getLotExp, observeLotExp, onLotExp } from "@/lib/v22/lot-registry";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { useMarketLotExp, useMarketLotExps } from "@/hooks/useMarketLotExp";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

function legacyUseMarketLotExp(slab: string | null | undefined): number | null {
  const subscribe = (cb: () => void) => onLotExp((s) => (s === slab ? cb() : undefined));
  const value = useSyncExternalStore(
    subscribe,
    () => getLotExp(slab),
    () => (isDevnetV22Enabled() ? null : 0),
  );
  useEffect(() => {
    if (slab && isDevnetV22Enabled()) ensureLotExp(slab);
  }, [slab]);
  return value;
}

function legacyUseMarketLotExps(slabs: readonly string[]): Map<string, number | null> {
  const key = [...slabs].sort().join(",");
  const read = (): Map<string, number | null> => new Map((key ? key.split(",") : []).map((s) => [s, getLotExp(s)]));
  const [map, setMap] = useState<Map<string, number | null>>(read);
  useEffect(() => {
    const list = key ? key.split(",") : [];
    setMap(read());
    if (isDevnetV22Enabled()) for (const s of list) ensureLotExp(s);
    return onLotExp((s) => {
      if (list.includes(s)) setMap(read());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

function market(lotExp: number): Uint8Array {
  const L = LAYOUT_V22;
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  d[L.marketGroupOff + L.marketGroupLen + L.wrapperSlot.profileLotExp] = lotExp;
  return d;
}

const SLABS = Array.from({ length: 50 }, (_, i) => `PerfSlab${String(i).padStart(2, "0")}${"x".repeat(30)}`);
const N_CONSUMERS = 200;
const N_RENDERS = 100;
const N_EVENTS = 50;

type Impl = { one: typeof useMarketLotExp; many: typeof useMarketLotExps };

function run(impl: Impl) {
  __resetLotRegistryForTest();
  __setDevnetV22ForTest(true);
  counts.add = 0;
  counts.remove = 0;
  const seen: string[] = [];
  let bump: () => void = () => {};

  function One({ slab, id, tick }: { slab: string; id: number; tick: number }) {
    const k = impl.one(slab);
    seen.push(`${id}:${tick}:${k}`);
    return null;
  }
  function Many({ slabs, id, tick }: { slabs: string[]; id: number; tick: number }) {
    const m = impl.many(slabs);
    seen.push(`m${id}:${tick}:${[...m.entries()].map(([s, v]) => `${s.slice(8, 10)}=${v}`).join(",")}`);
    return null;
  }
  function App() {
    const [tick, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    return (
      <>
        {Array.from({ length: N_CONSUMERS }, (_, i) => (
          <One key={i} id={i} slab={SLABS[i % SLABS.length]} tick={tick} />
        ))}
        {Array.from({ length: 5 }, (_, i) => (
          <Many key={`m${i}`} id={i} slabs={SLABS.slice(i * 10, i * 10 + 10).reverse()} tick={tick} />
        ))}
      </>
    );
  }

  const t0 = performance.now();
  const { unmount } = render(<App />);
  for (let r = 0; r < N_RENDERS; r++) act(() => bump());
  for (let e = 0; e < N_EVENTS; e++) act(() => observeLotExp(SLABS[e], market((e % 6) + 1)));
  const ms = performance.now() - t0;
  const adds = counts.add;
  const removesDuring = counts.remove;
  unmount();
  return { ms, adds, removes: removesDuring, removesTotal: counts.remove, seen };
}

const legacy: Impl = { one: legacyUseMarketLotExp, many: legacyUseMarketLotExps };
const current: Impl = { one: useMarketLotExp, many: useMarketLotExps };
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => {
  __setDevnetV22ForTest(null);
  __resetLotRegistryForTest();
});

describe("useMarketLotExp subscribe churn", () => {
  it("returns identical exponents and resubscribes far less", () => {
    const L = Array.from({ length: 5 }, () => run(legacy));
    const C = Array.from({ length: 5 }, () => run(current));
    // identical sequence of returned values (every render of every consumer, in order)
    expect(C[0].seen).toEqual(L[0].seen);
    expect(C[0].seen.length).toBeGreaterThan(N_CONSUMERS * N_RENDERS);
    const lMs = median(L.map((r) => r.ms));
    const cMs = median(C.map((r) => r.ms));
    console.log(
      `[lotexp-churn] legacy: add=${L[0].adds} remove=${L[0].removes} median=${lMs.toFixed(1)}ms | ` +
        `current: add=${C[0].adds} remove=${C[0].removes} median=${cMs.toFixed(1)}ms`,
    );
    expect(C[0].adds).toBeLessThan(L[0].adds / 2);
    expect(C[0].removes).toBe(0); // nothing is resubscribed while mounted
    expect(C[0].removesTotal).toBe(C[0].adds); // and every listener is released on unmount
  }, 240_000);
});
