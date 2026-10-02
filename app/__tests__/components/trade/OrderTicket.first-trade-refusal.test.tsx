/**
 * GH#2953: a first fund-and-trade refused by the pre-sign simulation (the wallet never opened)
 * must leave a visible, calm, actionable line in the ticket — never a silent reset.
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
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount }));
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
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>,
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { FirstTradeDepositError } from "@/lib/first-trade";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function wallet(amount: string) {
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount, decimals: 6 } }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  wallet("12000000"); // 12 USDC in the wallet
  mocks.useUserAccount.mockReturnValue(null); // no trading account on this market yet
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.fund.mockResolvedValue({ signature: "sigFirst", portfolio: new PublicKey("11111111111111111111111111111111"), prompts: 1, created: true });
});

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
/** UX_SHOTS_OUT: the REAL ticket markup of a state, for scripts/ux-shots/shoot-html.mjs. */
async function snap(name: string) {
  const out = process.env.UX_SHOTS_OUT;
  if (!out) return;
  const fs = await import("node:fs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/${name}.html`, screen.getByTestId("order-ticket").outerHTML);
}
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });

async function place() {
  await act(async () => fireEvent.click(submit()));
  await act(async () => fireEvent.click(screen.getByTestId("confirm-trade")));
}

const WRAPPER = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
/** The shape lib/tx.ts SimulationRefusal carries (lib/tx is mocked here). */
function refusal(code: number) {
  const e = new Error(`Transaction simulation failed: {"InstructionError":[5,{"Custom":${code}}]}`) as Error & Record<string, unknown>;
  e.name = "SimulationRefusal";
  e.code = code;
  e.instructionIndex = 5;
  e.programId = WRAPPER;
  e.logs = [`Program ${WRAPPER} failed: custom program error: 0x${code.toString(16)}`];
  return e;
}

const wrongRefusalWorded = /goes through automatically/i;

describe("GH#2953 first trade refused before the wallet opened", () => {
  it("Custom(21) on fund-and-trade: a visible, calm line that says nothing was sent and to try again", async () => {
    mocks.fund.mockRejectedValueOnce(refusal(21));
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
    const line = screen.getByTestId("status-line");
    expect(line.dataset.kind).toBe("engine-catching-up");
    const body = screen.getByTestId("status-line-body").textContent ?? "";
    expect(body).toBe("The market is catching up with the latest prices. Nothing was sent. Try again in a moment.");
    // the old copy promised a retry this path never makes (the "ready." the issue saw)
    expect(body).not.toMatch(wrongRefusalWorded);
    await snap("first-trade-21");
  });

  it("CONTROL: the waiting trade path (account funded, no bundled deposit) keeps its auto-retry wording", async () => {
    mocks.useUserAccount.mockReturnValue({ account: { capital: 100_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    mocks.trade.mockRejectedValue(refusal(21));
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull(), { timeout: 15_000 });
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(screen.getByTestId("status-line-body").textContent).toMatch(wrongRefusalWorded);
  }, 20_000);
});

describe("GH#2953 the bundled deposit covers the market's minimum initial margin", () => {
  const withFloor = (floor: bigint) =>
    mocks.useEngineState.mockReturnValue({
      engine: null,
      params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n, minNonzeroImReq: floor },
      insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true,
    });

  it("$1 at 1x on a $2-floor market deposits 2.21 (floor + fee + 10%), not 1.11", async () => {
    withFloor(2_000_000n);
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("1");
    expect(submit().textContent).toBe("Deposit 2.21 USDC & Long");
    await place();
    expect(mocks.fund.mock.calls[0][0]).toMatchObject({ size: 1_000_000n, depositAtoms: 2_210_000n });
  });

  it("NEGATIVE CONTROL: no floor -> margin + fee + 10% as before (1.11)", async () => {
    withFloor(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("1");
    expect(submit().textContent).toBe("Deposit 1.11 USDC & Long");
  });

  it("NEGATIVE CONTROL: an order above the floor is unchanged ($5 -> 5.52)", async () => {
    withFloor(2_000_000n);
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    expect(submit().textContent).toBe("Deposit 5.52 USDC & Long");
  });
});
