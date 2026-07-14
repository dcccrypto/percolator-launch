/**
 * Regression: a prewarmed fresh-read must be SPENT once a close consumes it.
 *
 * The close path caches the authoritative on-chain position read for up to 4s
 * (so the confirm click reaches the wallet without a blocking RPC round-trip).
 * That cache was originally invalidated only in the `catch` block — so a
 * SUCCESSFUL close left the PRE-CLOSE size cached, and a second close inside
 * the TTL consumed it:
 *
 *   long 10 SOL → Close 50%  (sends -5; true size becomes 5)
 *   → Close 100% at T+2s → stale size 10 is read → sends -10
 *   → closes 5 AND OPENS A 5 SOL SHORT, while the UI reports success.
 *
 * That is exactly the over-close-into-opposite-exposure the fresh-read guard
 * exists to prevent — the cache had defeated the guard it was bolted onto.
 * These tests pin the invalidation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

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
vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: () => ({ priceE6: 81_170_000n }),
}));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/lib/errorMessages", () => ({
  humanizeError: (m: string) => m,
  withTransientRetry: async (fn: () => Promise<unknown>) => fn(),
}));

// parsePortfolioV17 returns whatever size the CURRENT on-chain bytes encode.
vi.mock("@percolatorct/sdk", () => ({
  AccountKind: { LP: 1 },
  isV17Account: () => true,
  parsePortfolioV17: (buf: Buffer) => ({
    owner: WALLET,
    legs: [{ active: true, basisPosQ: buf.readBigInt64LE(200) }],
  }),
}));

const getProgramAccounts = vi.fn();
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      getProgramAccounts: (...a: unknown[]) => getProgramAccounts(...a),
      getAccountInfo: vi.fn().mockResolvedValue(null),
    },
  }),
  useWalletCompat: () => ({ publicKey: WALLET }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ accounts: [], raw: new Uint8Array([1]), programId: PROGRAM }),
}));

import { useClosePosition } from "@/hooks/useClosePosition";

describe("useClosePosition — prewarmed read must be spent on success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onChainSize = 10_000_000n;
    getProgramAccounts.mockImplementation(async () => [
      { pubkey: new PublicKey(SLAB), account: { data: portfolioBytes(onChainSize) } },
    ]);
  });

  it("re-reads the chain for a SECOND close instead of reusing the pre-close size", async () => {
    const { result } = renderHook(() => useClosePosition(SLAB));

    // Close 50% of 10 SOL -> sends -5
    await act(async () => {
      await result.current.closePosition(50);
    });
    expect(tradeMock).toHaveBeenCalledTimes(1);
    expect(tradeMock.mock.calls[0][0].size).toBe(-5_000_000n);

    // The chain now holds 5 SOL. A second close immediately after MUST read
    // that, not the cached pre-close 10.
    onChainSize = 5_000_000n;

    await act(async () => {
      await result.current.closePosition(100);
    });

    expect(tradeMock).toHaveBeenCalledTimes(2);
    // If the stale read were reused this would be -10_000_000n, which would
    // close 5 and OPEN A 5 SOL SHORT.
    expect(tradeMock.mock.calls[1][0].size).toBe(-5_000_000n);
  });
});
