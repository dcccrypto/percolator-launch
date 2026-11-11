/**
 * Display-only "Buying power" (Council r6 M3): it must equal what the Max button allows at the SELECTED leverage, never exceed a
 * market cap (and say so when one binds), and must not fall as leverage rises unless that cap binds.
 * Harness from OrderTicket.max-engine-gate.test.tsx.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  engineView: {} as unknown,
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
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<object>()), decodeMarketEngineView: () => mocks.engineView }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => null }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: () => <div data-testid="close-panel" /> }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const U = 1_000_000n;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;

const bp = () => {
  const t = screen.getByTestId("buying-power").textContent ?? "";
  return Number(t.replace(/[^\d.]/g, ""));
};
const maxUsd = () => {
  const el = screen.getByTestId("limits-max-size-inline");
  return Number(el.getAttribute("data-max-q")) * 150 / 1e6; // $150 per SOL, q = 1e-6 SOL
};

function setup(opts: { capital: bigint; feeBps: bigint; decimals?: number }) {
  mocks.engineView = {};
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn(async () => ({ value: { amount: "0", decimals: opts.decimals ?? 6 } })), getAccountInfo: vi.fn(async () => null) },
  });
  mocks.useUserAccount.mockReturnValue({ account: { capital: opts.capital, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 0 });
  mocks.useEngineState.mockReturnValue({
    engine: null,
    params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: opts.feeBps },
    insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true,
  });
}

async function readAt(levs: number[]) {
  render(<OrderTicket slabAddress={SLAB} />);
  await act(async () => {});
  const out: Array<{ lev: number; bp: number; max: number | null }> = [];
  for (const lev of levs) {
    fireEvent.click(screen.getAllByTestId("trade-leverage-preset").find((b) => new RegExp(`^${lev}`).test(b.textContent ?? ""))!);
    await act(async () => {});
    out.push({ lev, bp: bp(), max: screen.queryByTestId("limits-max-size-inline") ? maxUsd() : null });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limits = marketLimits({ state: "off" });
  mocks.fillCaps = null;
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"), raw: new Uint8Array(8),
  });
});

describe("Buying power follows the Max button at the selected leverage", () => {
  it("balance-bound: rises with leverage and equals Max (it used to FALL as leverage rose)", async () => {
    setup({ capital: 10_000n * U, feeBps: 30n });
    const rows = await readAt([1, 3, 5, 10]);
    for (let i = 1; i < rows.length; i++) expect(rows[i].bp).toBeGreaterThanOrEqual(rows[i - 1].bp);
    for (const r of rows) {
      expect(r.max).not.toBeNull();
      expect(Math.abs(r.bp - (r.max as number))).toBeLessThan(0.05);
    }
    expect(screen.queryByTestId("buying-power-capped")).toBeNull();
  });

  it("cap-bound: never above the market's room, flat across leverage, and the label says the market limits it", async () => {
    setup({ capital: 10_000n * U, feeBps: 30n });
    mocks.fillCaps = { maxFillAbs: 8_166_666n }; // about $1,225 at $150
    const rows = await readAt([1, 3, 5, 10]);
    for (const r of rows) {
      expect(r.bp).toBeLessThanOrEqual(1225.01);
      expect(Math.abs(r.bp - (r.max as number))).toBeLessThan(0.05);
    }
    expect(rows[3].bp).toBeGreaterThanOrEqual(rows[0].bp);
    expect(screen.getByTestId("buying-power-capped").textContent).toMatch(/market/i);
  });
});

describe("Buying power uses Max's units at any collateral decimals", () => {
  for (const decimals of [2, 6, 9]) {
    it(`${decimals}-decimal collateral, market cap binding: equals Max in Max's own units`, async () => {
      const unit = 10n ** BigInt(decimals);
      setup({ capital: 10_000n * unit, feeBps: 30n, decimals });
      mocks.fillCaps = { maxFillAbs: 1_000_000_000n }; // 1e9 q = 150e9 atoms (9 dp: 150 tokens; 2/6 dp: above the balance, so the balance binds)
      const rows = await readAt([5]);
      // the same figure Max shows, read from the Max chip: q x price / 1e6 collateral atoms
      const maxQ = Number(screen.getByTestId("limits-max-size-inline").getAttribute("data-max-q"));
      const expected = (maxQ * 150) / Number(unit); // collateral units
      expect(Math.abs(rows[0].bp - expected)).toBeLessThan(Math.max(0.05, expected * 1e-6));
      expect(rows[0].bp).toBeLessThan(10_000 * 5 + 1);
      if (expected < 45_000) expect(screen.getByTestId("buying-power-capped")).toBeTruthy();
      else expect(screen.queryByTestId("buying-power-capped")).toBeNull();
    });
  }
});
