/**
 * The live price follows the on-chain mark when the price feed does not tick the slab (an unlisted or v2.2 slab,
 * skipped pool reads, a dead socket). It used to stay at its first value, and the order ticket sized orders from it.
 * The real SlabProvider over real market bytes (5bVTTMRc fixture); only the mark is varied, and no feed tick arrives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { type FC } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";

const h = vi.hoisted(() => ({
  mark: 1_000_000n,
  seed: null as null | { data: Uint8Array; owner: unknown },
  onChange: null as null | ((info: { data: Buffer; owner: unknown }) => void),
  feed: [] as Array<(d: unknown) => void>,
}));

// Real parse; only the mark the test drives is swapped in.
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  return { ...real, parseWrapperConfigV17: (d: Uint8Array, o: number) => ({ ...real.parseWrapperConfigV17(d, o), markEwmaE6: h.mark }) };
});
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockSlabState: () => null }));
vi.mock("@/lib/slabCache", () => ({ getSeedSlab: () => h.seed, setCachedSlab: () => {} }));
vi.mock("@/lib/priceStore/wsManager", () => ({
  getWsManager: () => ({
    subscribeChannel: () => () => {},
    onMessage: () => () => {},
    onMessageForChannel: (_c: string, l: (d: unknown) => void) => {
      h.feed.push(l);
      return () => {};
    },
    onStatusChange: () => () => {},
  }),
}));

const OWNER = new PublicKey(getConfig().programId);
let SLAB = ""; // a fresh address per test: the price store is module state
const BYTES = Buffer.from(JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")).dataBase64, "base64");
/** New bytes (SlabProvider skips identical ones) that parse the same. */
const changed = (n: number) => {
  const b = Buffer.from(BYTES);
  b[b.length - 1] = n;
  return b;
};
const getAccountInfo = vi.fn(async () => ({ data: BYTES, owner: OWNER }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      rpcEndpoint: "http://test",
      getAccountInfo,
      onAccountChange: (_pk: unknown, cb: (info: { data: Buffer; owner: unknown }) => void) => {
        h.onChange = cb;
        return 1;
      },
      removeAccountChangeListener: () => {},
    },
  }),
}));

import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { applyOnChainPoll, getLivePriceSnapshot, subscribeSlab } from "@/lib/priceStore/priceStore";
import { seedLotExp0 } from "../helpers/v22-fixtures";

seedLotExp0();

/** Like the order ticket: consumes the slab context and reads the store during render (it does not subscribe to it). */
const seen: Array<bigint | null> = [];
const Reader: FC = () => {
  useSlabState();
  seen.push(getLivePriceSnapshot(SLAB).priceE6);
  return null;
};
const mount = () => render(<SlabProvider slabAddress={SLAB}><Reader /></SlabProvider>);
const push = (mark: bigint, n: number) => act(() => {
  h.mark = mark;
  h.onChange!({ data: changed(n), owner: OWNER });
});

let unsubscribe: () => void = () => {};
beforeEach(() => {
  SLAB = Keypair.generate().publicKey.toBase58();
  h.mark = 1_000_000n;
  h.seed = null;
  h.onChange = null;
  h.feed.length = 0;
  seen.length = 0;
  getAccountInfo.mockReset();
  getAccountInfo.mockImplementation(async () => ({ data: BYTES, owner: OWNER }));
  unsubscribe = subscribeSlab(SLAB, () => {});
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe("SlabProvider keeps the live price on the chain mark when the feed is silent", () => {
  it("follows each fresh read, and a reader sees the new mark in the render those bytes trigger", async () => {
    mount();
    await waitFor(() => expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_000_000n)); // the first read wrote it
    push(2_000_000n, 1);
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(2_000_000n);
    expect(seen.at(-1)).toBe(2_000_000n);
    push(3_000_000n, 2);
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(3_000_000n);
    expect(seen.at(-1)).toBe(3_000_000n);
  });

  it("a live feed tick under 10 s old still wins over the chain mark", async () => {
    mount();
    await waitFor(() => expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_000_000n));
    for (const l of h.feed) l({ type: "price", slab: SLAB, price: 1.5 });
    document.dispatchEvent(new Event("visibilitychange")); // flush the buffered tick
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_500_000n);
    push(4_000_000n, 3);
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_500_000n);
  });

  it("back on a market whose seed-cache bytes equal the first network read: that fresh read still updates the price", async () => {
    applyOnChainPoll(SLAB, 7_000_000n); // left over from an earlier visit
    h.mark = 1_000_000n;
    h.seed = { data: BYTES, owner: OWNER }; // the same bytes the network read returns
    mount();
    await waitFor(() => expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_000_000n));
  });

  it("CONTROL: the seed cache (bytes possibly minutes old) never overwrites a price", async () => {
    applyOnChainPoll(SLAB, 7_000_000n);
    h.mark = 9_000_000n;
    h.seed = { data: changed(9), owner: OWNER };
    getAccountInfo.mockImplementationOnce(() => new Promise(() => {})); // the network read never lands
    mount();
    await act(async () => {});
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(7_000_000n);
  });
});

describe("SlabProvider: feed silence and market switches", () => {
  afterEach(() => vi.useRealTimers());

  it("feed ticked, then went silent while the mark did not change: the mark is followed once the tick is 10 s old", async () => {
    mount();
    await waitFor(() => expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_000_000n));
    getAccountInfo.mockImplementation(async () => ({ data: changed(1), owner: OWNER })); // the re-poll the tab-visible event triggers
    for (const l of h.feed) l({ type: "price", slab: SLAB, price: 1.5 });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_500_000n);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0 + 5_000);
    push(1_000_000n, 1); // new bytes, same mark: a live tick 5 s old still wins
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_500_000n);
    now.mockReturnValue(t0 + 11_000);
    // identical bytes (the steady backup poll): the byte-equality skip must not hide the mark
    await act(async () => {
      h.onChange!({ data: changed(1), owner: OWNER });
    });
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_000_000n);
    expect(seen.at(-1)).toBe(1_000_000n); // and the ticket re-rendered to read it
  });

  it("feed resumes after a silent spell: the tick wins again over the chain mark", async () => {
    mount();
    await waitFor(() => expect(getLivePriceSnapshot(SLAB).priceE6).toBe(1_000_000n));
    push(2_000_000n, 1);
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(2_000_000n);
    for (const l of h.feed) l({ type: "price", slab: SLAB, price: 2.5 });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(2_500_000n);
    push(3_000_000n, 2);
    expect(getLivePriceSnapshot(SLAB).priceE6).toBe(2_500_000n);
  });

  it("a market switch never carries one market's price into the other", async () => {
    const A = SLAB;
    const view = mount();
    await waitFor(() => expect(getLivePriceSnapshot(A).priceE6).toBe(1_000_000n));
    push(2_000_000n, 1);
    const B = Keypair.generate().publicKey.toBase58();
    h.mark = 5_000_000n;
    getAccountInfo.mockImplementationOnce(() => new Promise(() => {})); // B's first read has not landed
    view.rerender(<SlabProvider slabAddress={B}><Reader /></SlabProvider>);
    await act(async () => {});
    expect(getLivePriceSnapshot(B).priceE6).toBeNull();
    expect(getLivePriceSnapshot(A).priceE6).toBe(2_000_000n);
    // A late update for A's subscription cannot reach B
    expect(getLivePriceSnapshot(B).priceE6).toBeNull();
  });
});
