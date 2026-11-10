/**
 * Council r4 R3-8: background re-scan throttle. SlabProvider's `raw` changes every keeper push; each change used
 * to fire a getProgramAccounts scan. With `minIntervalMs` the scans coalesce into one trailing scan per interval,
 * and user actions (manual refresh / invalidation / provisional fill) lift the throttle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({ parsePortfolio: vi.fn() }));
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  parsePortfolio: mocks.parsePortfolio,
}));

import {
  triggerPortfolioScan,
  triggerHeldNftScan,
  requestFreshScans,
  SCAN_MIN_INTERVAL_MS,
} from "@/lib/userAccountScan";
import { slabPollDelayMs } from "@/components/providers/SlabProvider";
import { matcherPortfolio } from "../helpers/v22-fixtures";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";

let clockBase = 0;
let b = 100;
const pk = () => new PublicKey(new Uint8Array(32).fill(++b % 250));

function setup() {
  const programId = pk();
  const wallet = pk();
  const slabAddress = pk().toBase58();
  const portfolioPubkey = pk();
  const getProgramAccounts = vi.fn(async () => [{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
  const connection = { getProgramAccounts } as unknown as Connection;
  mocks.parsePortfolio.mockReturnValue({
    ...matcherPortfolio,
    owner: wallet,
    capital: 1_000n,
    pnl: 0n,
    reservedPnl: 0n,
    feeCredits: 0n,
    lastFeeSlot: 0n,
    legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 5n }],
  });
  return { programId, wallet, slabAddress, connection, getProgramAccounts };
}

beforeEach(() => {
  __setUnknownLotExpForTest(0);
  vi.useFakeTimers();
  // Monotonic clock across tests so a freshness window opened by an earlier test has expired.
  clockBase += 10 * 60_000;
  vi.setSystemTime(new Date(Date.parse("2026-11-10T00:00:00Z") + clockBase));
});
afterEach(() => vi.useRealTimers());

async function driveRawChanges(
  fire: (raw: Uint8Array) => Promise<unknown>,
  everyMs: number,
  totalMs: number,
) {
  for (let t = 0; t < totalMs; t += everyMs) {
    void fire(new Uint8Array([t & 255, (t >> 8) & 255]));
    await vi.advanceTimersByTimeAsync(everyMs);
  }
}

describe("R3-8 portfolio scan throttle", () => {
  it("20 raw changes over 60s with minIntervalMs run <= 7 scans (was one per change)", async () => {
    const s = setup();
    const fire = (raw: Uint8Array) =>
      triggerPortfolioScan({ connection: s.connection, programId: s.programId, slabAddress: s.slabAddress, publicKey: s.wallet, raw, minIntervalMs: SCAN_MIN_INTERVAL_MS });
    await fire(new Uint8Array([0])); // first scan always runs (store not yet resolved)
    await driveRawChanges(fire, 3_000, 60_000);
    expect(s.getProgramAccounts.mock.calls.length).toBeLessThanOrEqual(7);
    expect(s.getProgramAccounts.mock.calls.length).toBeGreaterThanOrEqual(5); // still refreshes every ~interval
  });

  it("without minIntervalMs every new raw still scans (existing contract)", async () => {
    const s = setup();
    const fire = (raw: Uint8Array) =>
      triggerPortfolioScan({ connection: s.connection, programId: s.programId, slabAddress: s.slabAddress, publicKey: s.wallet, raw });
    await driveRawChanges(fire, 3_000, 30_000);
    expect(s.getProgramAccounts.mock.calls.length).toBe(10);
  });

  it("a manual refresh lifts the throttle so a fresh trade is visible immediately", async () => {
    const s = setup();
    const fire = (raw: Uint8Array) =>
      triggerPortfolioScan({ connection: s.connection, programId: s.programId, slabAddress: s.slabAddress, publicKey: s.wallet, raw, minIntervalMs: SCAN_MIN_INTERVAL_MS });
    await fire(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(1_000);
    await fire(new Uint8Array([2])); // throttled
    expect(s.getProgramAccounts).toHaveBeenCalledTimes(1);
    requestFreshScans();
    await fire(new Uint8Array([3]));
    expect(s.getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("the trailing scan uses the newest raw and fires once", async () => {
    const s = setup();
    const fire = (raw: Uint8Array) =>
      triggerPortfolioScan({ connection: s.connection, programId: s.programId, slabAddress: s.slabAddress, publicKey: s.wallet, raw, minIntervalMs: SCAN_MIN_INTERVAL_MS });
    await fire(new Uint8Array([1]));
    for (const n of [2, 3, 4, 5]) void fire(new Uint8Array([n]));
    await vi.advanceTimersByTimeAsync(SCAN_MIN_INTERVAL_MS + 100);
    expect(s.getProgramAccounts).toHaveBeenCalledTimes(2);
  });
});

describe("R3-8 held-NFT scan throttle", () => {
  it("coalesces the 2-query NFT scan the same way", async () => {
    const programId = pk();
    const wallet = pk();
    const getProgramAccounts = vi.fn(async () => []);
    const connection = { getProgramAccounts } as unknown as Connection;
    const fire = (raw: Uint8Array) => triggerHeldNftScan({ connection, nftProgramId: programId, wallet, raw, minIntervalMs: SCAN_MIN_INTERVAL_MS });
    await fire(new Uint8Array([0]));
    await driveRawChanges(fire, 3_000, 60_000);
    expect(getProgramAccounts.mock.calls.length).toBeLessThanOrEqual(14); // 2 queries per scan, <= 7 scans
  });
});

describe("R3-8 slab poll backoff", () => {
  it("is the steady 5s cadence when healthy, doubles per failure, and caps at 60s", () => {
    expect(slabPollDelayMs(0)).toBe(5_000);
    expect(slabPollDelayMs(1)).toBe(10_000);
    expect(slabPollDelayMs(2)).toBe(20_000);
    expect(slabPollDelayMs(3)).toBe(40_000);
    expect(slabPollDelayMs(4)).toBe(60_000);
    expect(slabPollDelayMs(50)).toBe(60_000);
  });
});
