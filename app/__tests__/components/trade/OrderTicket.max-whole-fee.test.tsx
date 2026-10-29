/**
 * #3553 on v2.2: Max at the market's max leverage must size an order the engine accepts when the market charges the matcher's quote fee.
 * The engine charges base + quote fee before its IM gate; the ticket sized the gate on the base fee alone, so at 10x (IM 10%) the Max margin
 * left equity short by the quote fee and the program refused Custom(49) EngineInsufficientInitialMargin.
 * One 100 USDC account, $1 asset, IM 10%, base fee 10 bps, a kind-1 matcher whose price bound (60 bps) is charged as the quote fee.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(), useConnectionCompat: vi.fn(), useUserAccount: vi.fn(), useSlabState: vi.fn(), useEngineState: vi.fn(),
  limits: null as unknown,
}));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "TEST-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => 505_580_400n }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/limits/adl-reduce-only", () => ({ isAdlReduceOnly: () => false }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/position-change", async (orig) => ({ ...(await orig<object>()), takePositionChange: async () => null }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => null }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: () => <div /> }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/wallet/ConnectButton", () => ({ ConnectButton: () => null, default: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { engineOpenNeedAtoms } from "@/lib/first-trade";
import { ALL_ON, marketLimits } from "../../lib/limits/fixtures";

const SLAB = "6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const CAPITAL = 100_000_000n;
const IM = 1_000n;

function setup(quoteChannel: boolean) {
  const base = marketLimits();
  mocks.limits = marketLimits({
    matcher: { ...base.matcher!, kind: 1, v2: undefined, maxTotalBps: 60 },
    flags: { ...ALL_ON, p2FeeCharged: quoteChannel },
    riskLimits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0, execBandBps: 0, matcherExtMode: quoteChannel ? 1 : 0, maxRequestedFeeBps: quoteChannel ? 100 : 0, allDefault: !quoteChannel },
    // plenty of room on both sides so only the account's margin binds
    vaultLp: null,
    lp: { ...base.lp!, capital: 1_000_000_000_000n, posQ: 0n },
  });
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "0", decimals: 6, uiAmount: 0 } }) } });
  mocks.useUserAccount.mockReturnValue({ account: { capital: CAPITAL, positionSize: 0n, entryPrice: 0n, pnl: 0n, feeCredits: 0n }, idx: 0 });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"), raw: new Uint8Array(0),
  });
  mocks.useEngineState.mockReturnValue({
    engine: null, params: { initialMarginBps: IM, maintenanceMarginBps: 500n, tradingFeeBps: 10n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

/** Max at 10x; returns the order's margin in atoms as the ticket sized it (the size box holds the notional). */
async function maxAtTenX(): Promise<bigint> {
  render(<OrderTicket slabAddress={SLAB} />);
  await act(async () => { fireEvent.change(screen.getByTestId("trade-leverage-input"), { target: { value: "10" } }); });
  const max = screen.getAllByTestId("trade-size-preset").find((b) => /max/i.test(b.textContent ?? ""));
  expect(max).toBeTruthy();
  await act(async () => { fireEvent.click(max!); });
  const v = (screen.getByTestId("trade-size-input") as HTMLInputElement).value;
  return BigInt(Math.round(Number(v.replace(/,/g, "")) * 1e6)) / 10n;
}
const engineAccepts = (marginAtoms: bigint, chargedFeeBps: bigint) => {
  const need = engineOpenNeedAtoms(marginAtoms * 10n, IM, chargedFeeBps);
  return need.im + need.fee <= CAPITAL;
};

describe("Max at 10x on a market that charges the quote fee (#3553)", () => {
  it("the Max order clears the engine's gate at the whole fee (10 base + 60 quote = 70 bps)", async () => {
    setup(true);
    const margin = await maxAtTenX();
    expect(margin).toBeGreaterThan(90_000_000n); // still nearly all of the free capital
    expect(engineAccepts(margin, 70n)).toBe(true);
  });
  it("CONTROL: a market that charges no quote fee keeps the base-fee Max (the #3554 sizing), refused at neither fee", async () => {
    setup(false);
    const margin = await maxAtTenX();
    expect(engineAccepts(margin, 10n)).toBe(true);
    expect(margin).toBeGreaterThan(99_000_000n);
  });
  it("a typed order that fits at the base fee but not the whole fee is flagged before signing (exceedsBalance uses the whole fee)", async () => {
    const typed = async (quote: boolean) => {
      setup(quote);
      const { unmount } = render(<OrderTicket slabAddress={SLAB} />);
      await act(async () => { fireEvent.change(screen.getByTestId("trade-leverage-input"), { target: { value: "10" } }); });
      await act(async () => { fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "980" } }); }); // notional: margin 98
      const flagged = document.body.textContent?.match(/more than your available|Not enough|exceeds/i) !== null;
      const border = document.querySelector(".border-\\[var\\(--warning\\)\\]\\/50") !== null;
      unmount();
      return flagged || border;
    };
    // 98 margin + 0.98 fee fits 100 at 10 bps; 98 + 6.86 does not at 70 bps.
    expect(await typed(false)).toBe(false);
    expect(await typed(true)).toBe(true);
  });
  it("negative control: the base-fee sizing the old ticket used is refused at the whole fee", () => {
    // 99 USDC of margin at 10x: IM 99 + fee 0.99 fits 100 at 10 bps, 99 + 6.93 does not at 70.
    expect(engineAccepts(99_000_000n, 10n)).toBe(true);
    expect(engineAccepts(99_000_000n, 70n)).toBe(false);
  });
});
