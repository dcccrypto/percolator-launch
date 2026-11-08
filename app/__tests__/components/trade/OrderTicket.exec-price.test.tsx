/**
 * M7: after a v2.2 fill the result line and the saved entry carry the price the trader EFFECTIVELY paid: the FILL event's booked price
 * (the mark at execution) adjusted by the spread part of fee_atoms (fee channel). Never the mark the ticket showed. Council: effective
 * 89.7417, booked 89.5357, shown 89.50.
 *
 * Runs the REAL OrderTicket submit path; only the network edges are mocked (as in OrderTicket.merged-position-entry.test.tsx).
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
  getTransaction: vi.fn(),
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
vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<object>()), isDevnetV22Enabled: () => true }));
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

import { fillEventLogs } from "../../helpers/fill-event-fixture";
import { modeFixtures } from "../../helpers/v22-fixtures";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { effectivePriceE6, execFillFromLogs } from "@/lib/v22/exec-fill";
import { computePositionPnl } from "@/lib/position-pnl";
import { loadBook } from "@/lib/trade-book";
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
  mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn", getTransaction: mocks.getTransaction } });
  mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: WALLET, raw: new Uint8Array(modeFixtures().market) });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});


// the order's size for typing "5" at 1.20 with the test account (ticket-derived)
const FILLED = 4_166_666n;
const BOOKED = 100_000_000n; // the booked price = the mark at execution (the ticket's own mark is 1.20)
const BASE_BPS = decodeMarketEngineView(new Uint8Array(modeFixtures().market))!.tradeFeeBaseBps;
const NOTIONAL = (FILLED * BOOKED) / 1_000_000n;
// base fee + a 25 bps matcher spread, as the fee channel charges it
const FEE = (NOTIONAL * (BASE_BPS + 25n)) / 10_000n;
const landed = (priceE6: bigint, fee = FEE) => ({
  meta: {
    err: null,
    logMessages: fillEventLogs(WALLET, new PublicKey(SLAB), [{ flags: 8, requestedQ: FILLED, executedQ: FILLED, priceE6, quotedPriceE6: priceE6 + 1_000_000n, feeAtoms: fee }]),
  },
});
const effectiveOf = (priceE6: bigint, fee = FEE) =>
  effectivePriceE6(execFillFromLogs(landed(priceE6, fee).meta.logMessages, WALLET, { market: new PublicKey(SLAB) })!, BASE_BPS)!;

describe("OrderTicket: the price shown and saved is what the trader effectively paid (M7)", () => {
  it("the result line shows booked + the fee's spread part (above the mark, not the matcher quote); the saved ENTRY is the BOOKED price, so uPnL is 0 at an unchanged mark (N-1)", async () => {
    withPosition(0n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue(landed(BOOKED));
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const eff = effectiveOf(BOOKED);
    expect(eff > BOOKED).toBe(true);
    expect(eff < BOOKED + 1_000_000n).toBe(true); // and it is not the matcher's quote either
    // N-1: capital is already net of the fee/spread; the engine measures pnl from the BOOKED price. Saving the effective price as the
    // entry would count the spread twice (capital AND q x (mark - entry)).
    expect(getSavedEntry(SLAB, 0, W)).toMatchObject({ entryPriceE6: BOOKED, sizeQ: FILLED });
    expect(getSavedEntry(SLAB, 0, W)?.entryPriceE6).not.toBe(eff);
    const ONE = 1_000_000_000_000_000n;
    const pnlAt = (entry: bigint) => computePositionPnl({ basisQ: FILLED, aBasis: ONE, adlFactors: { aLong: ONE, aShort: ONE }, markE6: BOOKED, cachedEntryE6: entry, onChainPnl: 0n, initialMarginBps: 1000n, capital: 1_000_000_000n });
    expect(pnlAt(getSavedEntry(SLAB, 0, W)!.entryPriceE6).unrealizedPnl).toBe(0n);
    expect(pnlAt(eff).unrealizedPnl! < 0n).toBe(true); // control: the effective price as entry would book a phantom loss
    const line = screen.getByText(/Opened .* at /);
    expect(line.textContent).toContain((Number(eff) / 1e6).toFixed(2));
    expect(line.textContent).not.toContain("1.20");
    // the trade book follows the fill so the close can report the whole trade
    expect(loadBook(W, SLAB, WALLET.toBase58())).toMatchObject({ q: FILLED, avgE6: BOOKED, fees: FEE });
  });

  it("NEGATIVE: the fill could not be read: no price is claimed and the mark is NOT saved as the entry", async () => {
    withPosition(0n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue(null);
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
    const line = screen.getByText(/Opened /);
    expect(line.textContent).not.toMatch(/ at /);
  });

  it("an add averages with the BOOKED price of this fill", async () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 3, W, FILLED);
    withPosition(FILLED, 1_000_000n);
    mocks.change = { beforeQ: FILLED, afterQ: 2n * FILLED };
    mocks.getTransaction.mockResolvedValue(landed(BOOKED));
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(getSavedEntry(SLAB, 0, W)?.entryPriceE6).toBe((90_000_000n + BOOKED) / 2n);
  });
});
