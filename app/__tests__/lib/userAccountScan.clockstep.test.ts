/** Wall-clock step regressions: a backwards clock step must not freeze background scans. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({ parsePortfolio: vi.fn() }));
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  parsePortfolio: mocks.parsePortfolio,
}));

import { triggerPortfolioScan, triggerHeldNftScan, SCAN_MIN_INTERVAL_MS } from "@/lib/userAccountScan";
import { matcherPortfolio } from "../helpers/v22-fixtures";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";

const HOUR = 3_600_000;
let b = 40;
const pk = () => new PublicKey(new Uint8Array(32).fill(++b % 250));

beforeEach(() => {
  __setUnknownLotExpForTest(0);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2031-01-01T00:00:00Z")); // far past any other test's fresh window
});
afterEach(() => vi.useRealTimers());

describe("userAccountScan backwards clock step", () => {
  it("portfolio: after a 1h back-step the next background scan still runs within one interval", async () => {
    const programId = pk(), wallet = pk(), slabAddress = pk().toBase58(), pf = pk();
    const getProgramAccounts = vi.fn(async () => [{ pubkey: pf, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolio.mockReturnValue({ ...matcherPortfolio, owner: wallet, legs: [] });
    const fire = (raw: Uint8Array) =>
      triggerPortfolioScan({ connection: { getProgramAccounts } as unknown as Connection, programId, slabAddress, publicKey: wallet, raw, minIntervalMs: SCAN_MIN_INTERVAL_MS });
    await fire(new Uint8Array([1]));
    vi.setSystemTime(Date.now() - HOUR);
    void fire(new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(SCAN_MIN_INTERVAL_MS + 100);
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("held NFT: same", async () => {
    const programId = pk(), wallet = pk();
    const getProgramAccounts = vi.fn(async () => []);
    const fire = (raw: Uint8Array) =>
      triggerHeldNftScan({ connection: { getProgramAccounts } as unknown as Connection, nftProgramId: programId, wallet, raw, minIntervalMs: SCAN_MIN_INTERVAL_MS });
    await fire(new Uint8Array([1]));
    const n = getProgramAccounts.mock.calls.length;
    vi.setSystemTime(Date.now() - HOUR);
    void fire(new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(SCAN_MIN_INTERVAL_MS + 100);
    expect(getProgramAccounts.mock.calls.length).toBe(n * 2);
  });
});
