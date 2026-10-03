/**
 * #2976 / #2985 corrections, exercised through the REAL OrderTicket + REAL useMarketLimits
 * (only the on-chain LP resolver is mocked):
 *  - the post-burn LP-owner resolution holds OPENS only, never a close / reduce;
 *  - it runs only for a connected wallet on a renounced market (no scan for visitors, no
 *    lock for an unknown profile: mock mode, legacy slab, initial load);
 *  - a failed resolution fails OPEN (the wrapper's SameOwnerTrade 67 and the pre-sign
 *    simulation still refuse an open), and the resolved creator stays close-only.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const CREATOR = new PublicKey(new Uint8Array(32).fill(0x9c));
const VISITOR = new PublicKey(new Uint8Array(32).fill(0x42));
const RENOUNCED = { assetAdmin: PublicKey.default };

function slab(assetProfile: unknown) {
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
    assetProfile,
  });
}
function walletAs(pk: PublicKey | null) {
  mocks.useWalletCompat.mockReturnValue({ publicKey: pk, connected: pk !== null });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSameOwnerLpCache();
  walletAs(VISITOR);
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "100000000", decimals: 6 } }) },
  });
  mocks.useUserAccount.mockReturnValue(null);
  slab(RENOUNCED);
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.resolveMarketLp.mockReturnValue(new Promise(() => {})); // in flight forever
});

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });
const short = () => fireEvent.click(screen.getByTestId("trade-side-short"));
const acct = (capital: bigint, positionSize: bigint) => ({ account: { capital, positionSize, entryPrice: 1_000_000n, pnl: 0n }, idx: 3 });
const LONG_10 = acct(50_000_000n, 10_000_000n);

async function ticket(account: unknown = acct(50_000_000n, 0n)) {
  mocks.useUserAccount.mockReturnValue(account);
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
}

describe("post-burn LP-owner resolution in flight (renounced market, wallet connected)", () => {
  it("holds an OPEN with the calm loading label", async () => {
    await ticket();
    size("5");
    expect(submit().textContent).toBe("Loading market…");
    expect(submit().disabled).toBe(true);
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(1);
  });

  it("never holds a REDUCE / close of the wallet's position", async () => {
    await ticket(LONG_10);
    short();
    size("5");
    expect(submit().textContent).toBe("Short SOL 1×");
    expect(submit().disabled).toBe(false);
    size("10"); // full close
    expect(submit().textContent).toBe("Short SOL 1×");
    expect(submit().disabled).toBe(false);
  });

  it("CONTROL: a flip past the position (it opens the other side) is held", async () => {
    await ticket(LONG_10);
    short();
    size("15");
    expect(submit().textContent).toBe("Loading market…");
    expect(submit().disabled).toBe(true);
  });
});

describe("who pays for / is gated by the resolution", () => {
  it("unknown asset profile (mock / legacy / initial load): no scan, no lock", async () => {
    slab(null);
    await ticket();
    size("5");
    expect(submit().textContent).toBe("Long SOL 1×");
    expect(submit().disabled).toBe(false);
    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();
  });

  it("non-renounced market: no scan (asset_admin already identifies the creator)", async () => {
    slab({ assetAdmin: CREATOR });
    await ticket();
    size("5");
    expect(submit().textContent).toBe("Long SOL 1×");
    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();
  });

  it("no wallet connected: no getProgramAccounts scan on mount", async () => {
    walletAs(null);
    render(<OrderTicket slabAddress={SLAB} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();
  });
});

describe("resolution outcome", () => {
  it("resolved to ANOTHER owner: the visitor trades normally", async () => {
    mocks.resolveMarketLp.mockResolvedValue({ owner: CREATOR });
    await ticket();
    size("5");
    await waitFor(() => expect(submit().textContent).toBe("Long SOL 1×"));
    expect(submit().disabled).toBe(false);
  });

  it("resolved to THIS wallet (post-burn creator): close-only is preserved", async () => {
    walletAs(CREATOR);
    mocks.resolveMarketLp.mockResolvedValue({ owner: CREATOR });
    await ticket();
    size("5");
    await waitFor(() => expect(submit().textContent).toBe("Close-only for this wallet"));
    expect(submit().disabled).toBe(true);
  });

  it("resolution fails: fails OPEN for the visitor (no 'unavailable' lock, no retry button)", async () => {
    mocks.resolveMarketLp.mockRejectedValue(new Error("429"));
    await ticket();
    size("5");
    await waitFor(() => expect(submit().textContent).toBe("Long SOL 1×"));
    expect(submit().disabled).toBe(false);
    expect(screen.queryByTestId("same-owner-retry")).toBeNull();
  });
});
