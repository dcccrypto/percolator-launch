/**
 * QA 12:02 (2026-10-14): swordcat 6fonYScx… Long with less room than the minimum position leg must read "paused" for a CONNECTED flat wallet
 * and for a DISCONNECTED visitor (who lands on Short, so the Long tab must say it), and never show the trim notice instead.
 * Fed with the LIVE bytes of the market and its vault LP (read-only getAccountInfo, slot 510965503, 2026-10-14T11:03:18Z); the paused cases
 * patch ONLY the users' long open interest in a copy of those bytes so the room is 2.78 lots (QA's tx 5qGhtEN7… state), minimum leg 3 lots.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fx from "../../fixtures/v22-swordcat-live-510965503.json";

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
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SWORD-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 35_394_323n, priceUsd: 35.394323 }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => 510_965_503n }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 35.394323, priceE6: 35_394_323n }) }));
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
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { growthMarketView } from "@/lib/v21/growth-market";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const LIVE = b64(fx.market);
const N_CAP = 28_230_934n; // from the live LP (C_m 1,000,… at price 35,394,323): read with the app's own decoder below

function market(roomLongQ: bigint | null): Uint8Array {
  const raw = LIVE.slice();
  if (roomLongQ !== null) new DataView(raw.buffer).setBigUint64(2711, N_CAP - roomLongQ, true); // users' long OI (u128 low word; high word is 0)
  return raw;
}
function limitsFor(raw: Uint8Array) {
  const engine = decodeMarketEngineView(raw, 0)!;
  const lp = { capital: BigInt(fx.lp.capital), pnl: BigInt(fx.lp.pnl), feeCredits: BigInt(fx.lp.feeCredits) };
  const lpQ = BigInt(fx.lp.effectiveQ);
  const growth = growthMarketView({ raw, engine, lp: { capital: lp.capital, pnl: lp.pnl, feeCredits: lp.feeCredits }, lpEffectiveQ: lpQ, bound: true })!;
  return { raw, growth, limits: marketLimits({ state: "ready", flags: { p1: false, p2: false, p2FeeCharged: false, p3: false }, engine, growth, vaultLp: null }) };
}

function setup(o: { room: bigint | null; connected: boolean; position?: bigint }) {
  const { raw, limits } = limitsFor(market(o.room));
  mocks.limits = limits;
  mocks.useWalletCompat.mockReturnValue(o.connected ? { publicKey: new PublicKey("11111111111111111111111111111111"), connected: true } : { publicKey: null, connected: false });
  mocks.useConnectionCompat.mockReturnValue({ connection: {} });
  mocks.useUserAccount.mockReturnValue(
    o.connected ? { account: { capital: 2_000_000_000n, positionSize: o.position ?? 0n, entryPrice: 35_000_000n, pnl: 0n, feeCredits: 0n }, idx: 0 } : null,
  );
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"), raw,
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
}

beforeEach(() => { vi.clearAllMocks(); __setDevnetV22ForTest(true); });
afterEach(() => __setDevnetV22ForTest(null));

const labelOf = () => screen.queryByTestId("growth-capacity-label")?.textContent ?? null;
const typeSize = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });

describe("live bytes sanity", () => {
  it("room and minimum leg as read from the chain", () => {
    const { growth } = limitsFor(market(null));
    expect(growth.long.headroomQ).toBe(6_483_925n);
    expect(growth.short.headroomQ).toBe(28_230_934n);
  });
});

describe("swordcat Long, room 2.78 lots < minimum leg 3 lots", () => {
  it("CONNECTED flat wallet: the Long tab and the capacity row read paused, no trim notice", async () => {
    setup({ room: 2_780_000n, connected: true });
    render(<OrderTicket slabAddress={SLAB} />);
    // a paused Long auto-selects Short; pick the state a flat holder sees on the Long ticket via the tab label
    expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBe("true");
    expect(screen.getByTestId("trade-side-long").textContent).toMatch(/paused/i);
    expect(screen.queryByTestId("growth-trim-notice")).toBeNull();
  });
  it("DISCONNECTED visitor: lands on Short, and the Long tab says paused", () => {
    setup({ room: 2_780_000n, connected: false });
    render(<OrderTicket slabAddress={SLAB} />);
    expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBe("true");
    expect(screen.getByTestId("trade-side-long").textContent).toMatch(/paused/i);
    expect(screen.getByTestId("trade-side-short").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("trade-side-short").dataset.limitsHalted).toBeUndefined();
  });
  it("a holder whose leg is already at/above the minimum can still add: the Long tab stays open", () => {
    // 3.5 lots = 3_500_000 q held (swordcat lotExp 4: positionSize is in token Q)
    setup({ room: 2_780_000n, connected: true, position: 3_500_000n });
    render(<OrderTicket slabAddress={SLAB} />);
    expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBeUndefined();
  });
});

describe("QA 12:38: a connected HOLDER with almost no room (~$0.79 = 0.022 lots) reads Paused (full)", () => {
  // program (simulated, slot 510975605): a holder adding 1 / 5 / 0.5 lots into 0.07-0.09 lots of room LANDS a CLIPPED fill of exactly the room
  // (flags 9); there is no zero fill and no refusal, so the program imposes no floor on a holder's add. The floor is the ticket's own step:
  // the smallest add it can place is one whole lot (lot_exp 4).
  it("holder (3.5 lots held), room 0.022 lots: Long tab 'Paused (full)'", () => {
    setup({ room: 22_000n, connected: true, position: 3_500_000n });
    render(<OrderTicket slabAddress={SLAB} />);
    const long = screen.getByTestId("trade-side-long");
    expect(long.dataset.limitsHalted).toBe("true");
    expect(long.textContent).toMatch(/Paused \(full\)/);
  });
  it("holder, room just under one lot is paused; room of one lot or more is open", () => {
    for (const [room, paused] of [[999_999n, true], [1_000_000n, false], [2_780_000n, false]] as const) {
      setup({ room, connected: true, position: 3_500_000n });
      const { unmount } = render(<OrderTicket slabAddress={SLAB} />);
      expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBe(paused ? "true" : undefined);
      unmount();
    }
  });
  it("flat cases are unchanged: the exact 100-USDC rule (2.82 paused, 2.826 open)", () => {
    for (const [room, paused] of [[2_820_000n, true], [2_826_000n, false]] as const) {
      setup({ room, connected: true });
      const { unmount } = render(<OrderTicket slabAddress={SLAB} />);
      expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBe(paused ? "true" : undefined);
      unmount();
    }
  });
  it("a holder of the OTHER side (short) is never paused: the Long tab is a close", () => {
    setup({ room: 22_000n, connected: true, position: -3_500_000n });
    render(<OrderTicket slabAddress={SLAB} />);
    expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBeUndefined();
  });
});

describe("swordcat Long, room >= minimum leg: no pause", () => {
  it("live room 6.48 lots: both tabs open, connected and disconnected", () => {
    for (const connected of [true, false]) {
      setup({ room: null, connected });
      const { unmount } = render(<OrderTicket slabAddress={SLAB} />);
      expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBeUndefined();
      expect(screen.getByTestId("trade-side-short").dataset.limitsHalted).toBeUndefined();
      unmount();
    }
  });
  it("the rule is the program's notional rule, not whole lots: min leg 100 USDC at 35.394323 = 2.825 lots", () => {
    // simulated on the live program (price 35.97): a flat taker's long clipped to 2.80 lots LANDS (100.8 USDC); 1 lot is 113.
    for (const [room, paused] of [[2_820_000n, true], [2_826_000n, false], [3_000_000n, false]] as const) {
      setup({ room, connected: true });
      const { unmount } = render(<OrderTicket slabAddress={SLAB} />);
      expect(screen.getByTestId("trade-side-long").dataset.limitsHalted).toBe(paused ? "true" : undefined);
      unmount();
    }
  });
});
void act; void labelOf; void typeSize;
