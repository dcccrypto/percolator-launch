/**
 * M7 (L-2): the ticket's own Fee cell. On a fee-channel market with NEXT_PUBLIC_LIMITS_P2 off (the deployed configuration) the chain
 * still charges base + the matcher's requested fee, so the cell must read the estimated total (30 + 23 = 53 bps), labelled "(est.)",
 * not the base fee alone.
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
vi.mock("@/hooks/useSpreadQuoter", () => ({ useSpreadQuoter: () => () => ({ kind: "quote", bps: 23, execPriceE6: null, inFee: true }) }));
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



describe("OrderTicket Fee cell (L-2)", () => {
  it("channel on, P2 flag off: 'Fee (est.)' shows base + the quote's requested bps (53 bps), not 30", () => {
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(screen.getByText("Fee (est.)")).toBeInTheDocument();
    // ~5 USDC notional x 53 bps = 0.026499 (the base fee alone would read 0.015)
    expect(screen.getByText(/0\.0264/)).toBeInTheDocument();
    expect(screen.queryByText(/0\.015 /)).toBeNull();
  });
});
