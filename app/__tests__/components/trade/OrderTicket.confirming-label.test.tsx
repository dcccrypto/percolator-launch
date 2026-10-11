/**
 * #49: after the wallet signed, the trade button kept saying "Confirm in wallet…" for the whole
 * confirmation poll (up to 90 s), because nothing told the ticket the tx had been sent. useTrade now
 * forwards sendTx's onProgress as onConfirming, and the button switches to "Confirming…".
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
  check: vi.fn(),
  refresh: vi.fn(),
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
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
// Only the network read is stubbed; timedOutSignature is the real code.
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  prewarmTxLanding: vi.fn(),
  checkSignatureLanded: mocks.check,
}));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => (
    <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>
  ),
}));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SIG = bs58.encode(new Uint8Array(64).fill(9));
const CONN = { tag: "conn" };
const timeoutErr = () => new Error(`Confirmation timeout (90s) — tx may still land. Check explorer: ${SIG}`);
const submitBtn = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function submitOnce() {
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
  await act(async () => { fireEvent.click(submitBtn()); });
  const confirm = screen.queryByTestId("confirm-trade");
  if (confirm) await act(async () => { fireEvent.click(confirm); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.trade.mockReset(); // drop any unused mockImplementationOnce from the previous test
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: CONN });
  mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, accountIndex: 0 });
  mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: new PublicKey("11111111111111111111111111111111") });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Params = { onConfirming?: () => void };
const label = () => submitBtn().textContent;

describe("trade button after the wallet signed (#49)", () => {
  it("says Confirm in wallet until the trade is sent, then Confirming", async () => {
    let params: Params = {};
    let finish!: (sig: string) => void;
    mocks.trade.mockImplementationOnce((p: Params) => { params = p; return new Promise((r) => { finish = r; }); });
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    expect(label()).toBe("Confirm in wallet…");
    expect(typeof params.onConfirming).toBe("function");

    act(() => params.onConfirming!());
    expect(label()).toBe("Confirming…");
    expect(submitBtn().disabled).toBe(true);

    await act(async () => { finish(SIG); });
    expect(label()).not.toBe("Confirming…");
  });

  it("goes back to Confirm in wallet when a transient retry signs again", async () => {
    let second: Params = {};
    mocks.trade
      .mockImplementationOnce(async (p: Params) => { p.onConfirming!(); throw new Error("Blockhash not found"); })
      .mockImplementationOnce((p: Params) => { second = p; return new Promise(() => {}); });
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    await advance(3_000); // withTransientRetry's delay
    expect(mocks.trade).toHaveBeenCalledTimes(2);
    expect(label()).toBe("Confirm in wallet…");
    act(() => second.onConfirming!());
    expect(label()).toBe("Confirming…");
  });
});

describe("trade button around the market wait (#49)", () => {
  it("stays Confirming when the wait loop reports done after the send (onWaiting(false))", async () => {
    let finish!: (sig: string) => void;
    let params: Params & { onWaiting?: (w: boolean) => void } = {};
    mocks.trade.mockImplementationOnce((p: typeof params) => { params = p; return new Promise((r) => { finish = r; }); });
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    act(() => params.onWaiting!(true));
    expect(label()).toBe("Waiting for the latest price…");
    act(() => params.onConfirming!());
    act(() => params.onWaiting!(false)); // sendTxWaiting, after the confirmed send
    expect(label()).toBe("Confirming…");
    await act(async () => { finish(SIG); });
  });

  it("CONTROL: the wait ending before any send goes back to Confirm in wallet", async () => {
    let params: Params & { onWaiting?: (w: boolean) => void } = {};
    mocks.trade.mockImplementationOnce((p: typeof params) => { params = p; return new Promise(() => {}); });
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    act(() => params.onWaiting!(true));
    act(() => params.onWaiting!(false));
    expect(label()).toBe("Confirm in wallet…");
  });
});

// The multi-leg path (more legs than one tx carries) has no hook harness; this pins its wiring.
describe("multi-leg trades report the first broadcast (#49)", () => {
  it("useTrade hands onConfirming to broadcastSignedTx", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(`${__dirname}/../../../hooks/useTrade.ts`, "utf8");
    expect(src).toMatch(/broadcastSignedTx\(connection, tx, \{ onProgress: params\.onConfirming \}\)/);
  });
});
