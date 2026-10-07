/**
 * Audit #10 / GH#2804 follow-up: a trade whose confirmation timed out may still land. The ticket
 * keeps submit disabled while it watches the signature, then resolves the line (landed / dropped /
 * undetermined). It never flashes back to idle with the same order filled in.
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


const pending = () => screen.getByTestId("trade-pending");
const sizeInput = () => screen.getByTestId("trade-size-input") as HTMLInputElement;

describe("trade ticket after a confirmation timeout (audit #10)", () => {
  it("stays locked past the old 1.2 s reset while it watches, then reports the landed trade", async () => {
    mocks.trade.mockRejectedValueOnce(timeoutErr());
    mocks.check.mockResolvedValueOnce("unknown").mockResolvedValueOnce("landed");
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();

    expect(pending().dataset.state).toBe("watching");
    await advance(1_500); // old code flips back to idle at 1.2 s
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().textContent).toBe("Confirming…");
    expect(screen.queryByText(/We'll update this when it lands/)).toBeNull();
    fireEvent.click(screen.getByTestId("status-line-why"));
    expect(screen.getByRole("link").getAttribute("href")).toContain(SIG);
    fireEvent.click(submitBtn());
    expect(mocks.trade).toHaveBeenCalledTimes(1); // no second send
    expect(mocks.check).toHaveBeenCalledWith(CONN, SIG);

    await advance(4_000); // second poll -> landed
    expect(pending().dataset.state).toBe("landed");
    expect(screen.getByText(/possibly only in part/)).toBeTruthy();
    expect(sizeInput().value).toBe("");
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.trade).toHaveBeenCalledTimes(1);
  });

  it("keeps the watch line and the lock when the size is edited mid-watch", async () => {
    mocks.trade.mockRejectedValueOnce(timeoutErr());
    mocks.check.mockResolvedValue("unknown");
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    await advance(1_500);
    fireEvent.change(sizeInput(), { target: { value: "6" } });
    expect(pending().dataset.state).toBe("watching");
    expect(submitBtn().disabled).toBe(true);
  });

  it("re-enables the ticket with the order kept once the trade is dropped", async () => {
    mocks.trade.mockRejectedValueOnce(timeoutErr());
    mocks.check.mockResolvedValue("not-found");
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();

    await advance(20_000);
    expect(submitBtn().disabled).toBe(true); // a short not-found run is not a drop
    await advance(12_000);
    expect(pending().dataset.state).toBe("dropped");
    expect(screen.getByText(/Nothing changed\. You can try again\./)).toBeTruthy();
    expect(sizeInput().value).toBe("5");
    expect(submitBtn().disabled).toBe(false);
  });

  it("gives up after 120 s without a verdict and points at the explorer", async () => {
    mocks.trade.mockRejectedValueOnce(timeoutErr());
    mocks.check.mockResolvedValue("unknown");
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    await advance(124_000);
    expect(pending().dataset.state).toBe("undetermined");
    fireEvent.click(screen.getByTestId("status-line-why"));
    expect(screen.getByRole("link").getAttribute("href")).toContain(SIG);
    expect(submitBtn().disabled).toBe(false);
  });

  it("stops watching on a market switch and writes nothing into the next market's ticket", async () => {
    mocks.trade.mockRejectedValueOnce(timeoutErr());
    mocks.check.mockResolvedValue("unknown");
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    await advance(1_500);
    const calls = mocks.check.mock.calls.length;
    rerender(<OrderTicket slabAddress="9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn" />);
    mocks.check.mockResolvedValue("landed");
    await advance(10_000);
    expect(mocks.check.mock.calls.length).toBe(calls);
    expect(screen.queryByTestId("trade-pending")).toBeNull();
  });

  it("does not start a watch when the market changed while the trade was still confirming", async () => {
    let fail!: (e: Error) => void;
    mocks.trade.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    mocks.check.mockResolvedValue("unknown");
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    rerender(<OrderTicket slabAddress="9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn" />);
    await act(async () => { fail(timeoutErr()); });
    await advance(10_000);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(screen.queryByTestId("trade-pending")).toBeNull();
  });

  it("CONTROL: a non-timeout refusal never watches", async () => {
    mocks.trade.mockRejectedValueOnce(new Error("User rejected the request."));
    render(<OrderTicket slabAddress={SLAB} />);
    await submitOnce();
    await advance(1_500);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(submitBtn().disabled).toBe(false);
  });
});
