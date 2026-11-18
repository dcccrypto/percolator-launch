/**
 * A backwards clock step must not keep serving a prewarmed close read (freshReadCache, Date.now() stamps in memory).
 * `now - ts < maxAge` treats a negative age as fresh, so a pre-step read of the position size could size the close.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { modeFixtures } from "../helpers/v22-fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// M-3: the close sizes from the ADL-effective quantity, which needs a FRESH read of the
// market (a_side / epoch / mode). A real captured v2.2 market (a = ADL_ONE, epochs 0).
// Captured market of the ACTIVE mode: the v2.1 ANSEM bytes flag off, the v2.2 (VERSION 19) one-slot market flag on (helpers/v22-fixtures.ts).
const MARKET_BYTES = Buffer.from(modeFixtures().market);

const PROGRAM = new PublicKey("69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9");
const SLAB = "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV";
const WALLET = new PublicKey("7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G");

/** Portfolio bytes with a given active-leg size. */
function portfolioBytes(sizeQ: bigint): Buffer {
  const d = Buffer.alloc(9347);
  Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]).copy(d, 0);
  new PublicKey(SLAB).toBuffer().copy(d, 16);
  WALLET.toBuffer().copy(d, 116);
  d.writeBigInt64LE(sizeQ, 200); // placeholder leg slot — parse is mocked below
  return d;
}

const tradeMock = vi.fn().mockResolvedValue("sig-1");
let onChainSize = 10_000_000n; // 10 SOL

vi.mock("@/hooks/useTrade", () => ({
  useTrade: () => ({ trade: tradeMock }),
  prewarmTradeSubmission: vi.fn(),
}));
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({ idx: 0, account: { positionSize: onChainSize, capital: 100_000_000n } }),
}));
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: () => null, // force the program-scan path
  isLpPortfolio: () => false,
  makePortfolioScanKey: (p: PublicKey, s: string, o: PublicKey) => `${p}|${s}|${o}`,
}));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: () => ({ priceE6: 81_170_000n }),
}));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/lib/errorMessages", () => ({
  UserFacingError: class UserFacingError extends Error {},
  userFacingMessage: () => null,
  humanizeError: (m: string) => m,
  withTransientRetry: async (fn: () => Promise<unknown>) => fn(),
}));

// The portfolio parser returns whatever size the CURRENT on-chain bytes encode. The hook reads through lib/v22/layout, so that is the seam.
const parseStub = (buf: Buffer) => ({
  owner: WALLET,
  legs: [{ active: true, side: 0, aBasis: 1_000_000_000_000_000n, epochSnap: 0n, basisPosQ: buf.readBigInt64LE(200) }],
});
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  isWrapperAccount: () => true,
  parsePortfolio: (buf: Buffer) => parseStub(buf),
}));
vi.mock("@percolatorct/sdk", () => ({
  AccountKind: { LP: 1 },
  isV17Account: () => true,
  parsePortfolioV17: (buf: Buffer) => parseStub(buf),
}));

const getProgramAccounts = vi.fn();
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      getProgramAccounts: (...a: unknown[]) => getProgramAccounts(...a),
      getAccountInfo: vi.fn(async (pk: PublicKey) => (pk.toBase58() === SLAB ? { data: MARKET_BYTES } : null)),
    },
  }),
  useWalletCompat: () => ({ publicKey: WALLET }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ accounts: [], raw: new Uint8Array([1]), programId: PROGRAM }),
}));

import { useClosePosition } from "@/hooks/useClosePosition";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";

describe("useClosePosition — fresh-read cache vs the clock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    __setUnknownLotExpForTest(0);
    onChainSize = 10_000_000n;
    getProgramAccounts.mockImplementation(async () => [
      { pubkey: new PublicKey(SLAB), account: { data: portfolioBytes(onChainSize) } },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  it("re-reads the chain after the clock steps BACKWARDS (does not size from the pre-step read)", async () => {
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const { result } = renderHook(() => useClosePosition(SLAB));
    await act(async () => {
      result.current.prewarmClose();
      await new Promise((r) => setImmediate(r));
    });
    expect(getProgramAccounts).toHaveBeenCalledTimes(1);

    onChainSize = 5_000_000n; // position shrank (partial fill / ADL) after the prewarm
    vi.setSystemTime(new Date("2026-11-18T11:00:00Z")); // clock stepped back 1h

    await act(async () => {
      await result.current.closePosition(100);
    });
    expect(tradeMock).toHaveBeenCalledTimes(1);
    expect(tradeMock.mock.calls[0][0].size).toBe(-5_000_000n); // stale cache would send -10_000_000n
  });

  it("control: a read inside the TTL is still reused", async () => {
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const { result } = renderHook(() => useClosePosition(SLAB));
    await act(async () => {
      result.current.prewarmClose();
      await new Promise((r) => setImmediate(r));
    });
    onChainSize = 5_000_000n;
    vi.setSystemTime(new Date("2026-11-18T12:00:01Z"));
    await act(async () => {
      await result.current.closePosition(100);
    });
    expect(tradeMock.mock.calls[0][0].size).toBe(-10_000_000n);
  });
});
