/**
 * A backwards clock step must not keep serving cached trade accounts.
 *
 * The v17 trade-account cache stamps entries with Date.now() (memory only). `now - ts < TTL`
 * treats a NEGATIVE age as fresh, so after the clock steps back the stale accounts
 * (LP / matcher ctx) are reused until the clock passes the stamp again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  resolveMarketLp: vi.fn(),
  getPortfolioRawSnapshot: vi.fn(),
}));

vi.mock("@/lib/market-lp", () => ({ resolveMarketLp: mocks.resolveMarketLp }));
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
  assertCanonicalMatcher: () => {},
}));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  prewarmTxLanding: vi.fn(),
}));
vi.mock("@/lib/userAccountScan", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPortfolioRawSnapshot: mocks.getPortfolioRawSnapshot,
}));

import { prewarmTradeSubmission } from "@/hooks/useTrade";

const PROGRAM = new PublicKey(new Uint8Array(32).fill(1));
// module-level cache survives between tests: a fresh slab per test keeps each one isolated
let n = 100;
let SLAB = new PublicKey(new Uint8Array(32).fill(n));
const TAKER = new PublicKey(new Uint8Array(32).fill(3));
const lp = () => ({
  pubkey: new PublicKey(new Uint8Array(32).fill(13)),
  matcherProg: new PublicKey(new Uint8Array(32).fill(15)),
  matcherCtx: new PublicKey(new Uint8Array(32).fill(16)),
  matcherDelegate: new PublicKey(new Uint8Array(32).fill(17)),
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("useTrade trade-accounts cache vs the clock", () => {
  beforeEach(() => {
    SLAB = new PublicKey(new Uint8Array(32).fill(++n));
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.resolveMarketLp.mockReset().mockImplementation(async () => lp());
    mocks.getPortfolioRawSnapshot.mockReset().mockReturnValue({
      pubkey: new PublicKey(new Uint8Array(32).fill(9)),
      portfolio: { owner: TAKER },
    });
  });
  afterEach(() => vi.useRealTimers());

  const prewarm = async () => {
    prewarmTradeSubmission({} as never, PROGRAM, SLAB.toBase58(), TAKER);
    await flush();
  };

  it("control: a second prewarm inside the TTL reuses the cache", async () => {
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    await prewarm();
    vi.setSystemTime(new Date("2026-11-18T12:00:10Z"));
    await prewarm();
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after the clock steps BACKWARDS", async () => {
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    await prewarm();
    vi.setSystemTime(new Date("2026-11-18T11:00:00Z")); // clock stepped back 1h
    await prewarm();
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2);
  });

  it("re-resolves after the TTL has genuinely passed", async () => {
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    await prewarm();
    vi.setSystemTime(new Date("2026-11-18T12:02:00Z"));
    await prewarm();
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2);
  });
});
