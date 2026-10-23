/**
 * #3459: an open from the order ticket is sent with a limit built from the engine's effective
 * price on a v17/v18 market (like a close), not from the site feed, so a feed reading low no
 * longer fails every long with Custom(9) "slippage". A limit that can't be built is refused at
 * submit, before the confirm screen. Real market bytes (5bVTTMRc fixture) for the engine view.
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
  feedE6: 1_200_000n,
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
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: mocks.feedE6, priceUsd: Number(mocks.feedE6) / 1e6 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: Number(mocks.feedE6) / 1e6, priceE6: mocks.feedE6 }),
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrderTicket } from "@/components/trade/OrderTicket";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { PRICES_OUT_OF_SYNC_COPY } from "@/lib/limits/copy";

const MARKET_BYTES = new Uint8Array(
  Buffer.from(JSON.parse(readFileSync(join(__dirname, "..", "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")).dataBase64, "base64"),
);
const EFF = decodeMarketEngineView(MARKET_BYTES)!.effectivePriceE6;

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
  mocks.feedE6 = 1_200_000n;
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

const V17_SLAB = () => ({
  accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: WALLET,
  raw: MARKET_BYTES, wrapperConfigV17: { oracleMode: 3 },
});

describe("OrderTicket opens on a v17/v18 market (#3459)", () => {
  beforeEach(() => {
    withPosition(0n);
    mocks.useSlabState.mockReturnValue(V17_SLAB());
  });

  it("the engine price is a real, non-trivial number here", () => {
    expect(EFF > 0n).toBe(true);
  });

  it("a long is sent with the limit around the ENGINE price, though the feed reads 15% low", async () => {
    mocks.feedE6 = (EFF * 85n) / 100n;
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    const p = mocks.trade.mock.calls[0][0] as { limitPriceE6?: bigint; size: bigint };
    expect(p.limitPriceE6).toBe(computeLimitPriceE6({ markE6: EFF, size: p.size }));
    // the old feed-built limit sat below the price the chain fills at: a certain Custom(9)
    expect(computeLimitPriceE6({ markE6: mocks.feedE6, size: p.size })).toBeLessThan(EFF);
  });

  it("a short too, with the feed 15% high", async () => {
    mocks.feedE6 = (EFF * 115n) / 100n;
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5", "short");
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    const p = mocks.trade.mock.calls[0][0] as { limitPriceE6?: bigint; size: bigint };
    expect(p.size < 0n).toBe(true);
    expect(p.limitPriceE6).toBe(computeLimitPriceE6({ markE6: EFF, size: p.size }));
  });

  it("no readable engine price: refused at submit, nothing signed", async () => {
    mocks.useSlabState.mockReturnValue({ ...V17_SLAB(), raw: new Uint8Array(8) });
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(screen.getByText(/Couldn't read the market price just now/)).toBeTruthy();
  });
});

describe("OrderTicket opens on a legacy market (#3459)", () => {
  it("feed and chain disagree: refused at submit as 'prices out of sync', nothing signed", async () => {
    withPosition(0n);
    mocks.feedE6 = 1_200_000n;
    mocks.useSlabState.mockReturnValue({
      accounts: [], header: null, refresh: mocks.refresh, programId: WALLET,
      config: { collateralMint: MINT, decimals: 6, oracleAuthority: WALLET, indexFeedId: PublicKey.default, authorityPriceE6: 1_000_000n, lastEffectivePriceE6: 1_000_000n },
    });
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(screen.getByText(PRICES_OUT_OF_SYNC_COPY.body)).toBeTruthy();
  });

  it("CONTROL: they agree: sent with the feed-built limit", async () => {
    withPosition(0n);
    mocks.feedE6 = 1_005_000n;
    mocks.useSlabState.mockReturnValue({
      accounts: [], header: null, refresh: mocks.refresh, programId: WALLET,
      config: { collateralMint: MINT, decimals: 6, oracleAuthority: WALLET, indexFeedId: PublicKey.default, authorityPriceE6: 1_000_000n, lastEffectivePriceE6: 1_000_000n },
    });
    render(<OrderTicket slabAddress={SLAB} />);
    await submit("5");
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    const p = mocks.trade.mock.calls[0][0] as { limitPriceE6?: bigint; size: bigint };
    expect(p.limitPriceE6).toBe(computeLimitPriceE6({ markE6: 1_005_000n, size: p.size }));
  });
});
