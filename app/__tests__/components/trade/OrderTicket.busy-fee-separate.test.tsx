/**
 * Owner decision 2026-11-12 (item 3): on a growth market's busy side the 5% busy-side fee is shown as its OWN line (with a notice) in the
 * order ticket and in the confirm screen, and is NOT folded into the position's Entry. The REAL ticket mounts the REAL confirm modal.
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
  getTransaction: vi.fn(),
  quoteBps: 23,
  utilBps: 0n,
  charged: false,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useSpreadQuoter", () => ({ useSpreadQuoter: () => () => ({ kind: "quote", bps: mocks.quoteBps, execPriceE6: null, inFee: true }) }));
// P2 off (the deployed configuration): the estimate's QUOTE is not charged; a busy-side fee can still be in it (M9).
vi.mock("@/lib/limits/estimated-fee", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/estimated-fee")>()),
  ticketFeeForEstimate: () => (mocks.charged ? { charged: true, requestedBps: 23n, utilFeeBps: mocks.utilBps } : mocks.utilBps > 0n ? { charged: false, requestedBps: 0n, utilFeeBps: mocks.utilBps } : null),
}));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_200_000n, priceUsd: 1.2 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<object>()), isDevnetV22Enabled: () => true }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 1.2, priceE6: 1_200_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("gsap", () => ({ default: { fromTo: vi.fn() } }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/position-change", () => ({ takePositionChange: async () => mocks.change }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));


import { fillEventLogs } from "../../helpers/fill-event-fixture";
import { modeFixtures } from "../../helpers/v22-fixtures";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { effectivePriceE6, execFillFromLogs } from "@/lib/v22/exec-fill";
import { OrderTicket } from "@/components/trade/OrderTicket";
import { getSavedEntry } from "@/lib/entry-price";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const WALLET = new PublicKey("11111111111111111111111111111111");
const W = WALLET.toBase58();
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SIG = bs58.encode(new Uint8Array(64).fill(7));

function withPosition(positionSize: bigint) {
  mocks.useUserAccount.mockReturnValue({ idx: 0, account: { capital: 1_000_000_000n, positionSize, entryPrice: 0n, pnl: 0n }, accountIndex: 0 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  mocks.change = null;
  mocks.quoteBps = 23;
  mocks.utilBps = 0n;
  mocks.charged = false;
  mocks.trade.mockResolvedValue(SIG);
  mocks.useWalletCompat.mockReturnValue({ publicKey: WALLET, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn", getTransaction: mocks.getTransaction } });
  mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: WALLET, raw: new Uint8Array(modeFixtures().market) });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function typeSize(size = "5") {
  withPosition(0n);
  render(<OrderTicket slabAddress={SLAB} />);
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: size } });
}
async function openConfirm() {
  await typeSize();
  await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
}

describe("order ticket: the busy-side fee is its own line with a notice", () => {
  it("busy side (200 bps): a separate 'Busy-side fee' line with the rate and the amount, and the notice; the Fee row still holds the total", async () => {
    mocks.utilBps = 200n;
    await typeSize();
    const line = screen.getByTestId("ticket-busy-fee");
    expect(line.textContent).toContain("Busy-side fee");
    expect(line.textContent).toMatch(/2\.00% · 0\.0999\d+ /); // 200 bps of the ~5 USDC notional
    const notice = screen.getByTestId("ticket-busy-fee-notice").textContent ?? "";
    expect(notice).toContain("This side is busy.");
    expect(notice).toContain("2.00% busy-side fee");
    expect(notice).toContain("It is not part of your entry price.");
    // r9 review LOW-1: leverage is NOT fixed here (the selector goes above 1x), so the notice must not claim it is.
    expect(screen.getAllByTestId("trade-leverage-preset").some((b) => Number(b.getAttribute("data-leverage")) > 1)).toBe(true);
    expect(notice).not.toContain("fixed at 1x");
    // #3553 / item 3: the total fee (253 bps) still includes the busy-side part.
    expect(screen.getByText("Fee (est.)").parentElement?.textContent).toContain("0.126499");
  });
  it("no busy-side fee: no line, no notice", async () => {
    await typeSize();
    expect(screen.queryByTestId("ticket-busy-fee")).toBeNull();
    expect(screen.queryByTestId("ticket-busy-fee-notice")).toBeNull();
    expect(document.body.textContent).not.toContain("busy-side fee (");
  });
});

describe("confirm screen: the busy-side fee is its own line with a notice", () => {
  it("busy side: its own row (not the Trading Fee row) and the notice", async () => {
    mocks.utilBps = 200n;
    await openConfirm();
    const row = screen.getByTestId("confirm-busy-fee");
    expect(row.textContent).toContain("Busy-side fee:");
    expect(row.textContent).toMatch(/2\.00% · 0\.0999\d+ /);
    expect(screen.getByTestId("confirm-busy-fee-notice").textContent).toContain("It is not part of your entry price.");
    // the Trading Fee row stays the total (253 bps), unchanged
    expect(screen.getByText("Trading Fee (est.):").parentElement?.textContent).toContain("0.126499");
  });
  it("no busy-side fee: no row, no notice", async () => {
    await openConfirm();
    expect(screen.queryByTestId("confirm-busy-fee")).toBeNull();
    expect(screen.queryByTestId("confirm-busy-fee-notice")).toBeNull();
  });
});

describe("the saved Entry is the fill price, not the fill price plus the busy-side fee", () => {
  it("open with a 200 bps busy-side fee: Entry = booked + the 23 bps spread only", async () => {
    mocks.utilBps = 200n;
    const FILLED = 4_166_666n;
    const BOOKED = 100_000_000n;
    const base = decodeMarketEngineView(new Uint8Array(modeFixtures().market))!.tradeFeeBaseBps;
    const notional = (FILLED * BOOKED) / 1_000_000n;
    const fee = (notional * (base + 23n + 200n)) / 10_000n;
    const quoted = BOOKED + 230_000n; // 23 bps above the booked price
    const logs = fillEventLogs(WALLET, new PublicKey(SLAB), [{ flags: 8, requestedQ: FILLED, executedQ: FILLED, priceE6: BOOKED, quotedPriceE6: quoted, feeAtoms: fee }]);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-confirm")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const f = execFillFromLogs(logs, WALLET, { market: new PublicKey(SLAB) })!;
    const foldedIn = effectivePriceE6(f, base)!; // the old behaviour: busy fee inside the price
    const entry = getSavedEntry(SLAB, 0, W)!.entryPriceE6;
    expect(entry).toBe(effectivePriceE6(f, base, 200n)!);
    expect(entry).toBeLessThan(foldedIn);
    // ~23 bps above the booked price (not ~223)
    expect(Number(entry - BOOKED) / Number(BOOKED)).toBeLessThan(0.0025);
    expect(Number(entry - BOOKED) / Number(BOOKED)).toBeGreaterThan(0.0020);
  });
});
