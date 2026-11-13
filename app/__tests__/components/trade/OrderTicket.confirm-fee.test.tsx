/**
 * M7 (L-6 / L-7 / L-5): the REAL TradeConfirmationModal mounted by the REAL ticket (nothing in between is mocked) on a fee-channel market with
 * the P2 flag off. The confirm's Trading Fee must equal the ticket's Fee cell, with and without a busy-side fee, and must follow the
 * REFRESHED quote; the Fee tooltip must name the quote fee.
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
  quoteBps: 23,
  utilBps: 0n,
  charged: false,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useSpreadQuoter", () => ({ useSpreadQuoter: () => () => ({ kind: "quote", bps: mocks.quoteBps, execPriceE6: null, inFee: true }) }));
// P2 off (the deployed configuration): the estimate's QUOTE is not charged; a busy-side fee can still be in it (M9).
vi.mock("@/lib/limits/estimated-fee", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/estimated-fee")>()),
  ticketFeeForEstimate: () => (mocks.charged ? { charged: true, requestedBps: 23n, utilFeeBps: mocks.utilBps } : mocks.utilBps > 0n ? { charged: false, requestedBps: 0n, utilFeeBps: mocks.utilBps } : null),
}));
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
vi.mock("gsap", () => ({ default: { fromTo: vi.fn() } }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/position-change", () => ({ takePositionChange: async () => mocks.change }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));


import { modeFixtures } from "../../helpers/v22-fixtures";
import { OrderTicket } from "@/components/trade/OrderTicket";
// Round 10: these pin the fee PARTS (what is added once, never twice); the display margin has its own tests (spread-size-aware).
vi.stubEnv("NEXT_PUBLIC_FEE_CAP_MARGIN_BPS", "0");

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
  mocks.quoteBps = 23;
  mocks.utilBps = 0n;
  mocks.charged = false;
  mocks.trade.mockResolvedValue(SIG);
  mocks.useWalletCompat.mockReturnValue({ publicKey: WALLET, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn", getTransaction: mocks.getTransaction } });
  mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: WALLET, raw: new Uint8Array(modeFixtures().market) });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});




const feeOf = (el: HTMLElement) => /([0-9.]+)\s/.exec(el.textContent ?? "")![1];
const cellFee = () => feeOf(screen.getByText("Fee (est.)").parentElement as HTMLElement);
const modalFee = () => feeOf(screen.getByText("Trading Fee (est.):").parentElement as HTMLElement);
async function openConfirm() {
  withPosition(0n);
  render(<OrderTicket slabAddress={SLAB} />);
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
  await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
}

describe("ticket Fee cell == real confirm Trading Fee", () => {
  it("P2 off, no busy-side fee: 30 + 23 = 53 bps in both, the quote added once", async () => {
    await openConfirm();
    expect(cellFee()).toBe("0.026499");
    expect(modalFee()).toBe(cellFee());
    expect(screen.getByTestId("confirm-spread")).toHaveTextContent("included in the trading fee");
  });
  it("P2 off WITH a busy-side fee (30 + 200 + 23 = 253 bps): both rows agree, neither double-adds the quote nor drops it", async () => {
    mocks.utilBps = 200n;
    await openConfirm();
    expect(cellFee()).toBe("0.126499"); // 253 bps of ~5 USDC
    expect(modalFee()).toBe(cellFee());
  });
  it("P2 ON with a CHARGED quote (30 + 23 + 200 = 253 bps already in the estimate): neither the cell nor the confirm adds the quote a second time", async () => {
    mocks.charged = true;
    mocks.utilBps = 200n;
    await openConfirm();
    expect(cellFee()).toBe("0.126499");
    expect(modalFee()).toBe(cellFee());
  });
  it("L-5: the Fee tooltip names the quote fee (never 'base fee plus .'), and the busy-side fee when present", async () => {
    const tooltip = () => {
      const icon = screen.getByText("Fee (est.)").querySelector("span[tabindex]") as HTMLElement;
      fireEvent.focus(icon);
      fireEvent.mouseEnter(icon);
      return document.body.textContent ?? "";
    };
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    const t1 = tooltip();
    expect(t1).toMatch(/0\.30% base fee plus the market maker's quote fee\./);
    expect(t1).not.toMatch(/base fee plus \./);
    cleanup();
    mocks.utilBps = 200n;
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(tooltip()).toMatch(/base fee plus the market maker's quote fee and the busy-side fee\./);
  });
  it("L-7: the confirm's fee follows the REFRESHED quote together with its spread row (23 bps at open, 40 bps after the refresh)", async () => {
    await openConfirm();
    expect(modalFee()).toBe("0.026499");
    mocks.quoteBps = 40;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5.5" } }); // any re-render: the quote source now answers 40
    expect(modalFee()).toBe("0.034999"); // 70 bps of the snapshot's ~5 USDC notional
    expect(screen.getByTestId("confirm-spread")).toHaveTextContent("~0.40%");
  });
});
