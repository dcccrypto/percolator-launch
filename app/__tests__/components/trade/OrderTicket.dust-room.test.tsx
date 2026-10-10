/**
 * A side whose LP room is non-zero but worth less than one cent is FULL (paused), exactly like
 * a room of 0. Seen live on SOL/USD (2026-10-05): the matcher inventory sat a few q short of
 * -max_inventory_abs, so the long room was a few q (< $0.01). The ticket showed "Max $0.00",
 * rewrote every typed USD size to "0.00" with a flickering "Reduced to the most available now:
 * $0.00 USD", and never showed the "Paused" label it shows for a room of exactly 0.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  fillCaps: null as unknown,
  limits: null as unknown,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => mocks.fillCaps }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
// $150 per SOL: 1 q (1e-6 SOL) = $0.00015, so one cent is 66.67 q.
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 150_000_000n, priceUsd: 150 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 150, priceE6: 150_000_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/limits/adl-reduce-only", () => ({ isAdlReduceOnly: () => false }));
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<object>()), decodeMarketEngineView: () => ({}) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => null }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: () => <div data-testid="close-panel" /> }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { lpInventoryRoomQ } from "@/lib/limits/lp-inventory-room";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const MAX_INV = 1_000_000_000n; // 1,000 SOL

/** The matcher ctx as read live: inventory_base, max_inventory_abs, no per-trade cap. */
function matcher(inventoryBase: bigint, maxInventoryAbs = MAX_INV) {
  return {
    maxFillAbs: 0n, // 0 = no per-trade cap
    maxInventoryAbs,
    inventoryBase,
    lpRealQ: null,
    syncLive: false,
    sideRoomQ: (side: "long" | "short") =>
      lpInventoryRoomQ({ counterQ: inventoryBase, realQ: null, maxInventoryAbs, syncLive: false }, side),
  };
}

const sizeInput = () => screen.getByTestId("trade-size-input") as HTMLInputElement;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const longBtn = () => screen.getByTestId("trade-side-long") as HTMLButtonElement;
const shortBtn = () => screen.getByTestId("trade-side-short") as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limits = marketLimits({ state: "off" });
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: {} });
  mocks.useUserAccount.mockReturnValue({ account: { capital: 5_000_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 0 });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"), raw: new Uint8Array(8),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});

describe("sub-cent LP room on a side = that side is full", () => {
  it("long room of 3 q ($0.00045): LONG is Paused, the ticket moves to SHORT, a typed size is never rewritten to 0.00", () => {
    // LP short at -max + 3 q: 3 q of room for a trader long, ~2,000 SOL for a trader short.
    mocks.fillCaps = matcher(-MAX_INV + 3n);
    render(<OrderTicket slabAddress={SLAB} />);

    expect(longBtn().disabled).toBe(true);
    expect(longBtn().dataset.limitsHalted).toBe("true");
    expect(within(longBtn()).getByTestId("trade-side-paused").textContent).toBe("Paused");
    expect(shortBtn().getAttribute("aria-pressed")).toBe("true");
    // the Max is the open side's, never "$0.00"
    expect(screen.getByTestId("limits-max-size-inline").dataset.side).toBe("short");
    expect(screen.getByTestId("order-ticket").textContent).not.toMatch(/Max \$0\.00/);

    fireEvent.change(sizeInput(), { target: { value: "5" } });
    expect(sizeInput().value).toBe("5");
    expect(screen.queryByTestId("limits-clamp-notice")).toBeNull();
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toBe("Short SOL 1×");
  });

  it("both rooms sub-cent: Opening paused, submit disabled, the size is not rewritten and no clamp notice flickers", () => {
    mocks.fillCaps = matcher(0n, 3n);
    render(<OrderTicket slabAddress={SLAB} />);

    expect(screen.getByTestId("order-ticket").dataset.ticketRow).toBe("both-paused");
    expect(longBtn().disabled).toBe(true);
    expect(shortBtn().disabled).toBe(true);
    for (const v of ["1", "12", "0.5"]) {
      fireEvent.change(sizeInput(), { target: { value: v } });
      expect(sizeInput().value).toBe(v);
      expect(screen.queryByTestId("limits-clamp-notice")).toBeNull();
      expect(submit().disabled).toBe(true);
      expect(submit().textContent).toBe("Opening paused");
    }
    expect(screen.queryByTestId("limits-max-size-inline")).toBeNull();
  });

  it("room of 66 q ($0.0099) is still full: the threshold is one cent", () => {
    mocks.fillCaps = matcher(-MAX_INV + 66n);
    render(<OrderTicket slabAddress={SLAB} />);
    expect(longBtn().disabled).toBe(true);
    expect(shortBtn().getAttribute("aria-pressed")).toBe("true");
  });

  it("CONTROL: a room of 67 q ($0.01005) is open, shows Max $0.01 and clamps to 0.01, not 0.00", () => {
    mocks.fillCaps = matcher(-MAX_INV + 67n);
    render(<OrderTicket slabAddress={SLAB} />);
    expect(longBtn().disabled).toBe(false);
    expect(longBtn().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("limits-max-size-inline").textContent).toBe("Max $0.01");

    fireEvent.change(sizeInput(), { target: { value: "5" } });
    expect(sizeInput().value).toBe("0.01");
    expect(screen.getByTestId("limits-clamp-notice").textContent).toBe("Reduced to the most available now: $0.01 USD");
  });

  it("CONTROL: a room of exactly 0 stays paused (unchanged)", () => {
    mocks.fillCaps = matcher(-MAX_INV);
    render(<OrderTicket slabAddress={SLAB} />);
    expect(longBtn().disabled).toBe(true);
    expect(within(longBtn()).getByTestId("trade-side-paused").textContent).toBe("Paused");
    expect(shortBtn().getAttribute("aria-pressed")).toBe("true");
  });
});
