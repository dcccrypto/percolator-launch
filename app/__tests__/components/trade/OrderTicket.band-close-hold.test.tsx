/**
 * #3609: on a v2.2 band market, while the mark lags its target the wrapper refuses (Custom 104) any fill whose REDUCING part
 * lands on the side the stale price favours: a partial close, a full close, or a flip (rc23 `band_favourable_close_refused_view`).
 * The dock already disabled its Close; the ticket must hold the same orders BEFORE the wallet, with the dock's reason line.
 * Controls: an increase on the same side, the unfavoured side, a price that is not lagging, a floor-stuck price, no band view.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bandView: null as unknown,
  scanPending: false,
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
  closePosition: vi.fn(),
  rawSnap: vi.fn(() => null as unknown),
  closable: vi.fn(() => ({ closable: false }) as { closable: boolean }),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => mocks.scanPending }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => mocks.bandView }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>,
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => mocks.rawSnap() }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => mocks.closable() }));

vi.mock("@/hooks/useClosePosition", () => ({ useClosePosition: () => ({ closePosition: mocks.closePosition, prewarmClose: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { catchUpAvailableLine } from "@/lib/limits/catchup-estimate";
import { bandCatchUpMs, type BandRentView } from "@/lib/v22/band-rent-state";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const OWNER = new PublicKey("11111111111111111111111111111111");

/** Mark 1.10 above a 1.00 target: a long's close (a sell at the mark) is the favoured side. */
const band = (lagging: boolean, favourableCloseSide: "long" | "short" | null, floorStuck = false): BandRentView => ({
  assetIndex: 0,
  lotExp: 0,
  band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 0n, recoveryMinutes: 64 },
  price: { capBpsPerSlot: 4n, markE6: 1_100_000n, targetE6: 1_000_000n, lagging, floorStuck, favourableCloseSide },
  rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n },
});
/** The line the dock shows (PositionsDock: catchUpAvailableLine(bandCatchUpMs(view), "close")). */
const dockLine = (v: BandRentView) => catchUpAvailableLine(bandCatchUpMs(v), "close");

const holding = (positionSize: bigint) =>
  mocks.useUserAccount.mockReturnValue({ idx: 3, pubkey: OWNER, account: { kind: 0, owner: OWNER, capital: 100_000_000n, positionSize, entryPrice: 1_000_000n, pnl: 0n, adlABasis: 1_000_000_000_000_000n } });

beforeEach(() => {
  vi.clearAllMocks();
  __setDevnetV22ForTest(true);
  mocks.rawSnap.mockReturnValue(null);
  mocks.closable.mockReturnValue({ closable: false });
  mocks.bandView = null;
  mocks.scanPending = false;
  mocks.useWalletCompat.mockReturnValue({ publicKey: OWNER, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "12000000", decimals: 6 } }) } });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(), raw: null,
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.trade.mockResolvedValue("sigTrade");
  mocks.closePosition.mockResolvedValue({ signature: "sigClose" });
  holding(40_000_000n); // long 40
});
afterEach(() => __setDevnetV22ForTest(null));

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });
const side = (s: "long" | "short") => fireEvent.click(screen.getByTestId(`trade-side-${s}`));
const openTab = (m: "open" | "close") => {
  const tab = screen.getAllByTestId("trade-mode-tab").find((t) => t.dataset.mode === m)!;
  fireEvent.click(tab);
};

async function ticket(dir: "long" | "short", amount: string) {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryAllByTestId("trade-mode-tab").length).toBe(2));
  openTab("open");
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  side(dir);
  size(amount);
}
async function tryPlace() {
  if (!submit().disabled) {
    await act(async () => fireEvent.click(submit()));
    const confirm = screen.queryByTestId("confirm-trade");
    if (confirm) await act(async () => fireEvent.click(confirm));
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

describe("#3609 Open tab: a reducing or flipping order on the favoured side is held before the wallet", () => {
  for (const [label, dir, amount] of [["partial close (short 5 against long 40)", "short", "5"], ["flip (short 50 against long 40)", "short", "50"]] as const) {
    it(`${label}: submit disabled, the dock's reason shown, nothing sent`, async () => {
      const v = band(true, "long");
      mocks.bandView = v;
      await ticket(dir, amount);
      await waitFor(() => expect(screen.queryByTestId("trade-band-close-hold")).not.toBeNull());
      expect(screen.getByTestId("trade-band-close-hold").textContent).toContain(dockLine(v));
      expect(submit().disabled).toBe(true);
      await tryPlace();
      expect(mocks.trade).not.toHaveBeenCalled();
      expect(mocks.fund).not.toHaveBeenCalled();
    });
  }
  it("a short holder on the favoured short side is held the same way (long 5 against short 40)", async () => {
    holding(-40_000_000n);
    const v = band(true, "short");
    mocks.bandView = v;
    await ticket("long", "5");
    await waitFor(() => expect(screen.queryByTestId("trade-band-close-hold")).not.toBeNull());
    expect(screen.getByTestId("trade-band-close-hold").textContent).toContain(dockLine(v));
    expect(submit().disabled).toBe(true);
  });

  const controls: Array<[string, () => void, "long" | "short"]> = [
    ["an increase on the same side (long 5 on long 40)", () => { mocks.bandView = band(true, "long"); }, "long"],
    ["the unfavoured side (short is favoured, the long reduces)", () => { mocks.bandView = band(true, "short"); }, "short"],
    ["a price that is not lagging", () => { mocks.bandView = band(false, null); }, "short"],
    ["a floor-stuck price", () => { mocks.bandView = band(true, null, true); }, "short"],
    ["no band view (non-band market / v2.2 flag off)", () => { mocks.bandView = null; }, "short"],
  ];
  for (const [label, setup, dir] of controls) {
    it(`CONTROL: ${label} -> not held, the order reaches the wallet`, async () => {
      setup();
      await ticket(dir, "5");
      await tryPlace();
      expect(screen.queryByTestId("trade-band-close-hold")).toBeNull();
      expect(mocks.trade).toHaveBeenCalledTimes(1);
    });
  }
});

describe("#3609 Close tab: the favoured-side close is disabled with the dock's reason", () => {
  it("long 40, long favoured: Close is disabled and titled with the dock's line, and the panel says so", async () => {
    const v = band(true, "long");
    mocks.bandView = v;
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryAllByTestId("trade-mode-tab").length).toBe(2));
    openTab("close");
    const btn = (await screen.findByTestId("close-confirm")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe(dockLine(v));
    expect(screen.getByTestId("close-catching-up").textContent).toContain(dockLine(v));
    await act(async () => fireEvent.click(btn));
    expect(mocks.closePosition).not.toHaveBeenCalled();
  });
  for (const [label, v] of [["unfavoured side", band(true, "short")], ["not lagging", band(false, null)], ["floor-stuck", band(true, null, true)], ["no band view", null]] as const) {
    it(`CONTROL: ${label} -> Close enabled`, async () => {
      mocks.bandView = v;
      render(<OrderTicket slabAddress={SLAB} />);
      await waitFor(() => expect(screen.queryAllByTestId("trade-mode-tab").length).toBe(2));
      openTab("close");
      const btn = (await screen.findByTestId("close-confirm")) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(screen.queryByTestId("close-catching-up")).toBeNull();
    });
  }
});
