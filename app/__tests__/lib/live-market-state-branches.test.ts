// @vitest-environment node
/**
 * Branch coverage for lib/live-market-state.ts: the tombstone / wrong-owner / null-data
 * classification in resolveSlabAccounts, the default-connection fallback, and the lot-market
 * and config-unreadable branches of parseLiveState.
 *
 * Invariant asserted throughout: an RPC failure, a timeout, a bad address or a lookalike account
 * is NEVER reported as `missing` (a missing market is dropped from the UI).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const cfgMock = vi.hoisted(() => ({ parse: null as null | (() => unknown) }));
const lotMock = vi.hoisted(() => ({ exp: 0 }));
const rpcMock = vi.hoisted(() => ({ getServerConnection: vi.fn() }));

vi.mock("@percolatorct/sdk", () => ({
  deriveStakePool: vi.fn(() => [new PublicKey("So11111111111111111111111111111111111111112")]),
  isV17Account: vi.fn(() => true),
  parseWrapperConfigV17: vi.fn(() => cfgMock.parse?.()),
  parseMarketGroupV17OI: vi.fn(() => {
    throw new Error("not under test");
  }),
  V17_HEADER_LEN: 16,
  V17_MARKET_GROUP_OFF: 592,
}));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: rpcMock.getServerConnection }));
vi.mock("@/lib/v22/lot", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/lot")>()),
  lotExpOf: () => lotMock.exp,
}));

import { getConfig } from "@/lib/config";
import { buildClosedMarketTombstone } from "@/lib/closed-market-tombstone";
import {
  readLiveMarketStateResolutions,
  readLiveMarketStates,
  readSlabExistence,
  SLAB_PROBE_TIMEOUT_MS,
} from "@/lib/live-market-state";

const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
const LIVE = Keypair.generate().publicKey.toBase58();
const wrapper = () => new PublicKey(getConfig().programId);
const otherOwner = () => Keypair.generate().publicKey;
const tomb = () => Buffer.from(buildClosedMarketTombstone());
const liveInfo = () => ({ data: Buffer.alloc(4096), owner: wrapper() });
const conn = (impl: () => Promise<unknown>) =>
  ({ getMultipleAccountsInfo: vi.fn(impl) }) as unknown as Connection;

beforeEach(() => {
  cfgMock.parse = () => ({ markEwmaE6: 150_000_000n, marketauth: SOL_MINT, tradeFeeBps: 30n });
  lotMock.exp = 0;
  rpcMock.getServerConnection.mockReset();
});

describe("tombstone / wrong-owner classification", () => {
  it("wrapper-owned 16-byte tombstone is missing AND tombstoned (readLiveMarketStateResolutions)", async () => {
    const r = await readLiveMarketStateResolutions(
      [A],
      conn(async () => [{ data: tomb(), owner: wrapper() }]),
    );
    expect([...r.missing]).toEqual([A]);
    expect([...r.tombstoned]).toEqual([A]);
    expect(r.unresolved.size).toBe(0);
    expect(r.states.size).toBe(0);
  });

  it("wrapper-owned tombstone is missing AND tombstoned (readSlabExistence)", async () => {
    const r = await readSlabExistence(
      [A, B],
      conn(async () => [{ data: tomb(), owner: wrapper() }, { data: Buffer.alloc(17), owner: wrapper() }]),
    );
    expect([...r.missing]).toEqual([A]);
    expect([...r.tombstoned]).toEqual([A]);
    expect(r.missing.has(B)).toBe(false);
    expect(r.unresolved.size).toBe(0);
  });

  it("wrong owner: tombstone bytes under another program are NOT missing (lookalike)", async () => {
    const r = await readLiveMarketStateResolutions(
      [A],
      conn(async () => [{ data: tomb(), owner: otherOwner() }]),
    );
    expect(r.missing.size).toBe(0);
    expect(r.tombstoned.size).toBe(0);
    expect(r.unresolved.has(A) || r.states.has(A)).toBe(true); // not hidden either way

    const e = await readSlabExistence([A], conn(async () => [{ data: tomb(), owner: otherOwner() }]));
    expect(e.missing.size).toBe(0);
    expect(e.tombstoned.size).toBe(0);
    expect(e.unresolved.size).toBe(0); // exists, just not ours: not hidden
  });

  it("missing owner on tombstone bytes is NOT missing", async () => {
    const r = await readLiveMarketStateResolutions([A], conn(async () => [{ data: tomb(), owner: null }]));
    expect(r.missing.size).toBe(0);
    expect(r.unresolved.has(A) || r.states.has(A)).toBe(true);
    const e = await readSlabExistence([A], conn(async () => [{ data: tomb() }]));
    expect(e.missing.size).toBe(0);
    expect(e.tombstoned.size).toBe(0);
  });

  it("existing account with null data is unresolved, never missing", async () => {
    const r = await readLiveMarketStateResolutions(
      [A],
      conn(async () => [{ data: null, owner: wrapper() }]),
    );
    expect(r.missing.size).toBe(0);
    expect(r.unresolved.has(A)).toBe(true);
  });
});

describe("RPC failure is never reported as missing", () => {
  it("rejected call, both readers", async () => {
    const fail = () =>
      conn(async () => {
        throw new Error("503");
      });
    for (const r of [
      await readLiveMarketStateResolutions([A, B], fail()),
      await readSlabExistence([A, B], fail()),
    ]) {
      expect(r.missing.size).toBe(0);
      expect(r.tombstoned.size).toBe(0);
      expect([...r.unresolved].sort()).toEqual([A, B].sort());
    }
  });

  it("invalid address mixed with a tombstone: invalid is unresolved, not missing", async () => {
    const r = await readSlabExistence(
      ["not-a-key", A],
      conn(async () => [{ data: tomb(), owner: wrapper() }]),
    );
    expect(r.missing.has("not-a-key")).toBe(false);
    expect(r.unresolved.has("not-a-key")).toBe(true);
    expect(r.missing.has(A)).toBe(true);
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it("a hung probe is unresolved after SLAB_PROBE_TIMEOUT_MS, never missing", async () => {
      const p = readSlabExistence([A], conn(() => new Promise(() => {})));
      await vi.advanceTimersByTimeAsync(SLAB_PROBE_TIMEOUT_MS + 1);
      const r = await p;
      expect(r.missing.size).toBe(0);
      expect(r.unresolved.has(A)).toBe(true);
    });
  });

  it("readLiveMarketStates (map only) drops failures without throwing", async () => {
    const m = await readLiveMarketStates([A], conn(async () => {
      throw new Error("boom");
    }));
    expect(m.size).toBe(0);
  });
});

describe("default connection", () => {
  it("uses the server connection; existence probe disables 429 retry, state read does not", async () => {
    const getMultipleAccountsInfo = vi.fn(async () => [null, liveInfo()]);
    rpcMock.getServerConnection.mockReturnValue({ getMultipleAccountsInfo });

    await readSlabExistence([A, LIVE]);
    expect(rpcMock.getServerConnection).toHaveBeenLastCalledWith("confirmed", { disableRetryOnRateLimit: true });

    await readLiveMarketStateResolutions([A, LIVE]);
    expect(rpcMock.getServerConnection).toHaveBeenLastCalledWith("confirmed", {});
  });
});

describe("parseLiveState branches", () => {
  const read = async () => (await readLiveMarketStateResolutions([LIVE], conn(async () => [liveInfo()]))).states.get(LIVE);

  it("lot market (lotExp != 0) with a price converts through lot helpers", async () => {
    lotMock.exp = 3;
    const s = await read();
    expect(s).toBeDefined();
    expect(s!.markPriceUsd).not.toBeNull();
    expect(s!.totalOiUsd).not.toBeNull();
  });

  it("lot market with no usable price has null price and null OI value", async () => {
    lotMock.exp = 3;
    cfgMock.parse = () => ({ markEwmaE6: 0n, marketauth: SOL_MINT, tradeFeeBps: 30n });
    const s = await read();
    expect(s!.markPriceUsd).toBeNull();
    expect(s!.totalOiUsd).toBeNull();
  });

  it("unreadable config fails closed: isComplete=false, price null, state still returned", async () => {
    cfgMock.parse = () => {
      throw new Error("short config");
    };
    const s = await read();
    expect(s).toBeDefined();
    expect(s!.isComplete).toBe(false);
    expect(s!.markPriceUsd).toBeNull();
    expect(s!.maxLeverage).toBeNull();
  });
});
