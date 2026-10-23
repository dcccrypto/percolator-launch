/**
 * #3314: adding to an open position keeps an exact entry (size-weighted), so Share PnL stays.
 *
 * Runs the REAL OrderTicket submit path; only the network edges are mocked, as in
 * OrderTicket.confirm-timeout.test.tsx. The on-chain position measurement
 * (lib/position-change.ts, tested on its own) is driven directly.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  trade: vi.fn(),
  refresh: vi.fn(),
  change: null as null | { beforeQ: bigint; afterQ: bigint },
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_200_000n, priceUsd: 1.2 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 1.2, priceE6: 1_200_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/position-change", () => ({ takePositionChange: async () => mocks.change }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => (
    <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>
  ),
}));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { getSavedEntry, saveEntryPrice } from "@/lib/entry-price";
import { resolveEntryPrice } from "@/lib/trading";
import { isExactEntrySource } from "@/lib/entry-price-display";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const WALLET = new PublicKey("11111111111111111111111111111111");
const W = WALLET.toBase58();
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SIG = bs58.encode(new Uint8Array(64).fill(7));

function withPosition(positionSize: bigint, pnl = 0n) {
  mocks.useUserAccount.mockReturnValue({
    idx: 0,
    account: { capital: 1_000_000_000n, positionSize, entryPrice: 0n, pnl },
    accountIndex: 0,
  });
}

async function submit(size: string, side: "long" | "short" = "long") {
  if (side === "short") fireEvent.click(screen.getByTestId("trade-side-short"));
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: size } });
  await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
  const confirm = screen.queryByTestId("confirm-trade");
  if (confirm) await act(async () => { fireEvent.click(confirm); });
  // let the measured-entry step settle
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  mocks.change = null;
  mocks.trade.mockResolvedValue(SIG);
  mocks.useWalletCompat.mockReturnValue({ publicKey: WALLET, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn" } });
  mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: WALLET });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("OrderTicket: the saved entry across a merged position (#3314)", () => {
  it("a first long saves this fill as its entry, then records the measured size", async () => {
    withPosition(0n);
    mocks.change = { beforeQ: 0n, afterQ: 5_000_000n };
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    expect(getSavedEntry(SLAB, 0, W)).toMatchObject({ entryPriceE6: 1_200_000n, sizeQ: 5_000_000n });
  });

  it("THE FIX: a second long averages the saved entry with this fill, so Share PnL stays", async () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, 3, W, 40_000_000n);
    withPosition(40_000_000n, 8_000_000n);
    // measured: +40 more filled at 1.20 → 80 @ 1.10
    mocks.change = { beforeQ: 40_000_000n, afterQ: 80_000_000n };
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("40");
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    const saved = getSavedEntry(SLAB, 0, W);
    expect(saved).toEqual({ entryPriceE6: 1_100_000n, leverage: 3, sizeQ: 80_000_000n });
    // the dock's share gate accepts a saved entry again
    expect(isExactEntrySource(resolveEntryPrice(80_000_000n, saved!.entryPriceE6, 8_000_000n, 1_200_000n).source)).toBe(true);
  });

  it("the average weighs what was MEASURED to fill, not what was asked", async () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, undefined, W, 40_000_000n);
    withPosition(40_000_000n);
    mocks.change = { beforeQ: 40_000_000n, afterQ: 50_000_000n }; // asked 40, 10 filled
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("40");
    expect(getSavedEntry(SLAB, 0, W)?.entryPriceE6).toBe(1_040_000n); // (40·1.00 + 10·1.20) / 50
  });

  it("a saved entry from before this fix (no size) is not blended: cleared, as before", async () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, undefined, W);
    withPosition(40_000_000n, 8_000_000n);
    mocks.change = { beforeQ: 40_000_000n, afterQ: 80_000_000n };
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("40");
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
  });

  it("no measurement (read failed): a trade on an open position clears, as before", async () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, undefined, W, 40_000_000n);
    withPosition(40_000_000n, 8_000_000n);
    mocks.change = null;
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("40");
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
  });

  it("the ticket thought the position was open but it was flat on chain: a new entry, not a blend", async () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, undefined, W, 40_000_000n); // left by a position closed elsewhere
    withPosition(40_000_000n);
    mocks.change = { beforeQ: 0n, afterQ: 40_000_000n };
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("40");
    expect(getSavedEntry(SLAB, 0, W)).toMatchObject({ entryPriceE6: 1_200_000n, sizeQ: 40_000_000n });
  });

  it("ADL: a sell past the EFFECTIVE long flips it, so the long's entry is not kept for the short", async () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, undefined, W, 100_000_000n);
    withPosition(100_000_000n); // basis 100; effective 80 after ADL
    mocks.change = { beforeQ: 80_000_000n, afterQ: -10_000_000n };
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("90", "short");
    expect(getSavedEntry(SLAB, 0, W)).toMatchObject({ entryPriceE6: 1_200_000n, sizeQ: -10_000_000n });
  });
});
