/**
 * #2560 isolated margin, through the REAL OrderTicket (only the hooks/RPC edges are mocked).
 * Replaces the source-text grep tests of the first PR: these fail when the BEHAVIOUR breaks.
 *  - Isolated opens a brand-new portfolio (forceNewPortfolio) funded from the wallet; Cross
 *    trades in the existing account (useTrade), as today;
 *  - the receipt / liquidation preview of an isolated order is priced against an EMPTY portfolio,
 *    not the primary's size, entry and capital (the merged figure can look far safer);
 *  - the limits gate treats an isolated order as an OPEN even when it would reduce the primary;
 *  - isolated is not offered without a main account or without wallet funds (it would otherwise
 *    silently route to a cross trade, or become the cross account);
 *  - the entry is written SCOPED for isolated, never over the cross account's legacy entry.
 */
/**
 * #2976 / #2985 corrections, exercised through the REAL OrderTicket + REAL useMarketLimits
 * (only the on-chain LP resolver is mocked):
 *  - the post-burn LP-owner resolution holds OPENS only, never a close / reduce;
 *  - it runs only for a connected wallet on a renounced market (no scan for visitors, no
 *    lock for an unknown profile: mock mode, legacy slab, initial load);
 *  - a failed resolution fails OPEN (the wrapper's SameOwnerTrade 67 and the pre-sign
 *    simulation still refuse an open), and the resolved creator stays close-only.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
  resolveMarketLp: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
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
vi.mock("@/lib/market-lp", () => ({ resolveMarketLp: mocks.resolveMarketLp }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>,
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/wallet/ConnectButton", () => ({ ConnectButton: () => <div data-testid="connect" /> }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { __resetSameOwnerLpCache } from "@/hooks/useMarketLimits";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const WALLET = new PublicKey(new Uint8Array(32).fill(0x42));
const CROSS_PK = new PublicKey(new Uint8Array(32).fill(0x11));
const ISO_PK = new PublicKey(new Uint8Array(32).fill(0x22));

beforeEach(() => {
  vi.clearAllMocks();
  __resetSameOwnerLpCache();
  localStorage.clear();
  mocks.useWalletCompat.mockReturnValue({ publicKey: WALLET, connected: true });
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "100000000", decimals: 6 } }) }, // 100 USDC in the wallet
  });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
    assetProfile: null,
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.resolveMarketLp.mockResolvedValue(null);
  mocks.fund.mockResolvedValue({ signature: "sigIso", portfolio: ISO_PK, prompts: 1, created: true });
  mocks.trade.mockResolvedValue("sigCross");
});

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });
const isolated = () => fireEvent.click(screen.getByTestId("margin-mode-isolated"));
const cross = () => fireEvent.click(screen.getByTestId("margin-mode-cross"));
const short = () => fireEvent.click(screen.getByTestId("trade-side-short"));
const summary = () => screen.getByTestId("ticket-summary").textContent ?? "";
// a big, healthy CROSS long: 1,000 units at $1 on 1,000 USDC of collateral
const bigCross = { account: { capital: 1_000_000_000n, positionSize: 1_000_000_000n, entryPrice: 1_000_000n, pnl: 0n }, idx: 3, pubkey: CROSS_PK };
const flatCross = { account: { capital: 1_000_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3, pubkey: CROSS_PK };

async function ticket(account: unknown) {
  mocks.useUserAccount.mockReturnValue(account);
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
}

const place = async () => {
  await act(async () => fireEvent.click(submit()));
  await act(async () => fireEvent.click(screen.getByTestId("confirm-trade")));
};
const liqCell = () => {
  const m = summary().match(/Liq\. price(.*?)Fee/);
  return m ? m[1] : "";
};
const leverage = (x: string) => fireEvent.change(screen.getByTestId("trade-leverage-input"), { target: { value: x } });

describe("isolated liquidation preview is computed from an empty portfolio", () => {
  it("LONG: shows the isolated portfolio's own liquidation price, with no 'before' figure", async () => {
    await ticket(bigCross);
    leverage("5");
    size("10");
    isolated();
    const cell = liqCell();
    expect(cell).not.toContain("→"); // before = empty, so nothing to compare against
    const price = Number(cell.replace("$", ""));
    expect(price).toBeGreaterThan(0.7); // ~5x on its own margin: close to entry ($1.003) ...
    expect(price).toBeLessThan(0.95); // ... NOT the merged cross figure (~$0.01) or a health %
  });

  it("SHORT: the liquidation price sits ABOVE entry for the isolated portfolio", async () => {
    await ticket(bigCross);
    leverage("5");
    size("10");
    isolated();
    short();
    const price = Number(liqCell().replace("$", ""));
    expect(price).toBeGreaterThan(1.05);
    expect(price).toBeLessThan(1.3);
  });

  it("CONTROL: Cross still prices against the primary's whole position (merged before -> after)", async () => {
    await ticket(bigCross);
    leverage("5");
    size("10");
    expect(liqCell()).toContain("→");
    expect(liqCell()).toContain("mgn"); // the existing position's margin health is the 'before'
    isolated();
    expect(liqCell()).not.toContain("mgn");
    cross();
    expect(liqCell()).toContain("→"); // toggling back restores the cross preview
  });
});

describe("limits treat an isolated order as an OPEN", () => {
  const LONG_10 = { account: { capital: 50_000_000n, positionSize: 10_000_000n, entryPrice: 1_000_000n, pnl: 0n }, idx: 3, pubkey: CROSS_PK };
  const lpInFlight = () => {
    mocks.useSlabState.mockReturnValue({
      accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
      programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
      assetProfile: { assetAdmin: PublicKey.default },
    });
    mocks.resolveMarketLp.mockReturnValue(new Promise(() => {}));
  };

  it("CONTROL: a Cross short that REDUCES the primary's long is never held", async () => {
    lpInFlight();
    await ticket(LONG_10);
    short();
    size("5");
    expect(submit().textContent).toBe("Short SOL 1×");
    expect(submit().disabled).toBe(false);
  });

  it("the SAME short in Isolated opens a new position in a fresh portfolio, so it is held while the LP owner resolves", async () => {
    lpInFlight();
    await ticket(LONG_10);
    short();
    isolated();
    size("5");
    expect(submit().textContent).toBe("Loading market…");
    expect(submit().disabled).toBe(true);
  });
});

describe("isolated open flow", () => {
  it("funds a NEW portfolio (forceNewPortfolio) with the full margin and never calls trade()", async () => {
    await ticket(bigCross);
    isolated();
    size("5");
    await place();
    await waitFor(() => expect(mocks.fund).toHaveBeenCalledTimes(1));
    expect(mocks.trade).not.toHaveBeenCalled();
    const arg = mocks.fund.mock.calls[0][0] as { forceNewPortfolio: boolean; depositAtoms: bigint; size: bigint };
    expect(arg.forceNewPortfolio).toBe(true);
    expect(arg.depositAtoms).toBeGreaterThanOrEqual(5_000_000n); // the whole 5 USDC margin (+ fee), not netted against the primary's 1,000
    expect(arg.size).toBeGreaterThan(0n);
  });

  it("writes the entry under the NEW portfolio's scoped key and leaves the cross account's legacy entry alone", async () => {
    const legacy = `perc:entry:${SLAB}:3:${WALLET.toBase58()}`;
    localStorage.setItem(legacy, JSON.stringify({ entryPriceE6: "900000", timestamp: 1 }));
    await ticket(bigCross);
    isolated();
    size("5");
    await place();
    await waitFor(() => expect(mocks.fund).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(`${legacy}:${ISO_PK.toBase58()}`)).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(legacy)!).entryPriceE6).toBe("900000"); // cross entry untouched
  });

  it("CONTROL: the default (Cross) trades in the existing account through trade(), without a portfolio target or a new account", async () => {
    await ticket(bigCross);
    size("5");
    await place();
    await waitFor(() => expect(mocks.trade).toHaveBeenCalledTimes(1));
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.trade.mock.calls[0][0]).not.toHaveProperty("portfolioPk");
  });

  it("CONTROL: a cross open on a flat account still writes the LEGACY entry key", async () => {
    await ticket(flatCross);
    size("5");
    await place();
    await waitFor(() => expect(mocks.trade).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(`perc:entry:${SLAB}:3:${WALLET.toBase58()}`)).not.toBeNull());
  });
});

describe("isolated is only offered when it can really open a separate account", () => {
  it("no main account yet: not offered (it would itself become the cross account), nothing is sent", async () => {
    await ticket(null);
    isolated();
    size("5");
    expect(screen.getByTestId("isolated-unavailable").textContent).toMatch(/main account/);
    expect(submit().disabled).toBe(true);
    await act(async () => fireEvent.click(submit()));
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.trade).not.toHaveBeenCalled();
  });

  it("empty wallet: blocked with a calm line, never silently routed to a cross trade", async () => {
    mocks.useConnectionCompat.mockReturnValue({
      connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "0", decimals: 6 } }) },
    });
    await ticket(bigCross);
    isolated();
    size("5");
    await waitFor(() => expect(screen.getByTestId("isolated-unavailable").textContent).toMatch(/sim-USDC/));
    expect(submit().disabled).toBe(true);
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.trade).not.toHaveBeenCalled();
  });
});
