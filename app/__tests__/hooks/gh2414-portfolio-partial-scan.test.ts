/**
 * GH#2414 — the portfolio snapshot could publish an INCOMPLETE owner scan as if
 * it had completed successfully.
 *
 * Every failure path inside usePortfolio's load() was swallowed into an empty
 * result: a failed batch slab fetch, a failed per-market scan (which covers the
 * v17 getProgramAccounts owner scan), and a throw from market discovery. That
 * made "we could not read your positions" indistinguishable from "you have no
 * positions", understating position count, deposited capital, portfolio value,
 * unrealized PnL and liquidation risk.
 *
 * These tests pin the property that an incomplete scan reports itself as
 * incomplete.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const WALLET = new PublicKey("BXzwCWKsMpAW2MxWTWPaJu4fByYWkBFGBmLz4QxGUkwi");
const SLAB = new PublicKey("So11111111111111111111111111111111111111112");
const PROGRAM = new PublicKey("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");

const mockConnection = {
  getMultipleAccountsInfo: vi.fn(),
  getProgramAccounts: vi.fn(),
};

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: mockConnection }),
  useWalletCompat: () => ({ publicKey: WALLET }),
}));

vi.mock("@/lib/config", () => ({
  getAllProgramIds: () => [PROGRAM.toBase58()],
  getNetwork: () => "devnet",
}));

// Discovery returns one market; the failure under test happens after this.
vi.mock("@/lib/market-directory-discovery", () => ({
  discoverMarketsViaProgramDirectory: vi.fn(async () => [
    { slabAddress: SLAB, symbol: "SOL-PERP", name: "SOL/USD" },
  ]),
}));

vi.mock("@percolatorct/sdk", () => ({
  discoverMarketsViaStaticBundle: vi.fn(async () => []),
  parseAllAccounts: vi.fn(() => []),
  parseConfig: vi.fn(() => ({ lastEffectivePriceE6: 1_000_000n, invert: false })),
  parseParams: vi.fn(() => ({ maintenanceMarginBps: 500n })),
  parsePortfolioV17: vi.fn(() => ({ capital: 0n, pnl: 0n, reservedPnl: 0n, legs: [] })),
  parseWrapperConfigV17: vi.fn(() => ({ markEwmaE6: 1_000_000n })),
  isV17Account: vi.fn(() => true),
  AccountKind: { User: 0 },
  computeLiqPrice: vi.fn(() => 0n),
  computeMarkPnl: vi.fn(() => 0n),
  computePnlPercent: vi.fn(() => 0),
  V17_HEADER_LEN: 0,
}));

vi.mock("@/lib/health", () => ({ isSentinelValue: () => false }));
vi.mock("@/lib/oraclePrice", () => ({
  applyInvert: (p: bigint) => p,
  sanitizePriceE6: (p: bigint) => p,
}));
vi.mock("@/lib/entry-price", () => ({ getEntryPrice: () => 0n }));

async function getHook() {
  const mod = await import("@/hooks/usePortfolio");
  return mod.usePortfolio;
}

/** A slab account blob that isV17Account() will accept (mocked to true). */
function slabAccount() {
  return { data: Buffer.alloc(512), owner: PROGRAM };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockConnection.getMultipleAccountsInfo.mockResolvedValue([slabAccount()]);
  mockConnection.getProgramAccounts.mockResolvedValue([]);
});

describe("GH#2414 partial portfolio scan", () => {
  it("flags the snapshot as partial when the v17 owner scan fails", async () => {
    // The reported bug: getProgramAccounts fails for one v17 program while the
    // rest of the scan succeeds.
    mockConnection.getProgramAccounts.mockRejectedValue(new Error("RPC 429"));

    const usePortfolio = await getHook();
    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isPartial).toBe(true);
    expect(result.current.failedMarketCount).toBeGreaterThan(0);
  });

  it("flags the snapshot as partial when the batch slab fetch fails", async () => {
    // Worst case: this covers every market, so the old code produced an empty
    // portfolio that rendered as "you have no positions".
    mockConnection.getMultipleAccountsInfo.mockRejectedValue(new Error("RPC down"));

    const usePortfolio = await getHook();
    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isPartial).toBe(true);
    expect(result.current.positions).toHaveLength(0);
    // The critical distinction: zero positions AND a partial flag, so a
    // consumer can tell this apart from a genuinely empty wallet.
    expect(result.current.failedMarketCount).toBeGreaterThan(0);
  });

  it("reports a complete scan as NOT partial when everything succeeds", async () => {
    const usePortfolio = await getHook();
    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isPartial).toBe(false);
    expect(result.current.failedMarketCount).toBe(0);
  });

  it("an empty wallet is complete, not partial", async () => {
    // Both calls succeed and simply find nothing — this must stay
    // distinguishable from the failure cases above.
    mockConnection.getMultipleAccountsInfo.mockResolvedValue([slabAccount()]);
    mockConnection.getProgramAccounts.mockResolvedValue([]);

    const usePortfolio = await getHook();
    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.positions).toHaveLength(0);
    expect(result.current.isPartial).toBe(false);
  });

  it("exposes isPartial and failedMarketCount on the published snapshot", async () => {
    const usePortfolio = await getHook();
    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Guards the contract itself — consumers cannot read totals without these.
    expect(result.current).toHaveProperty("isPartial");
    expect(result.current).toHaveProperty("failedMarketCount");
    expect(typeof result.current.isPartial).toBe("boolean");
    expect(typeof result.current.failedMarketCount).toBe("number");
  });
});
