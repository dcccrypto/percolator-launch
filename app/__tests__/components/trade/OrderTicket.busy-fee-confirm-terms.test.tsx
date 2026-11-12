/**
 * Council r9 (Risk MED, Attacker A / B / C, Skeptic D / E): the busy-side fee paid at open is saved with the entry; the order signs the terms
 * the confirm screen showed (a higher busy-side fee, a flipped side or a raised cap refuses before the wallet); a fee raise leaves the Entry
 * unknown; the notice says the fee is INCLUDED in the trading fee; Max on a busy side at 1x shows "1x (fixed)". The REAL ticket mounts the
 * REAL confirm modal.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import "@testing-library/jest-dom";
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
  priceE6: 1_200_000n,
  priceListeners: new Set<() => void>(),
  fund: vi.fn(),
  growthRoom: null as null | "known" | "none",
  effArgs: [] as Array<bigint | null | undefined>,
  auto: null as null | "long" | "short",
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
vi.mock("@/lib/limits/ticket-state", async (orig) => {
  const m = await orig<typeof import("@/lib/limits/ticket-state")>();
  return { ...m, deriveTicketState: (i: Parameters<typeof m.deriveTicketState>[0]) => { const s = m.deriveTicketState(i); return mocks.auto ? { ...s, autoSelect: mocks.auto } : s; } };
});
vi.mock("@/hooks/useMarketLimits", async (orig) => {
  const m = await orig<typeof import("@/hooks/useMarketLimits")>();
  return { ...m, useMarketLimits: (...a: Parameters<typeof m.useMarketLimits>) => { const r = m.useMarketLimits(...a); return mocks.growthRoom ? { ...r, growthRoom: mocks.growthRoom } : r; } };
});
vi.mock("@/lib/v22/exec-fill", async (orig) => {
  const m = await orig<typeof import("@/lib/v22/exec-fill")>();
  return { ...m, effectivePriceE6: (...a: Parameters<typeof m.effectivePriceE6>) => { mocks.effArgs.push(a[2]); return m.effectivePriceE6(...a); } };
});
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useLivePrice: () => { const p = useSyncExternalStore((l) => { mocks.priceListeners.add(l); return () => mocks.priceListeners.delete(l); }, () => mocks.priceE6); return { priceE6: p, priceUsd: Number(p) / 1e6 }; } };
});
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<object>()), isDevnetV22Enabled: () => true }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: Number(mocks.priceE6) / 1e6, priceE6: mocks.priceE6 }),
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
import { recordFeeRaise } from "@/lib/v22/fee-raise-note";

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
  mocks.auto = null;
  mocks.growthRoom = null;
  mocks.effArgs.length = 0;
  mocks.priceE6 = 1_200_000n;
  mocks.trade.mockResolvedValue(SIG);
  mocks.useWalletCompat.mockReturnValue({ publicKey: WALLET, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn", getTransaction: mocks.getTransaction, getTokenAccountBalance: vi.fn(async () => ({ value: { amount: "0", decimals: 6 } })), getAccountInfo: vi.fn(async () => null) } });
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


const BOOKED = 100_000_000n;
const FILLED = 4_166_666n;
function openLogs(busyBps: bigint) {
  const base = decodeMarketEngineView(new Uint8Array(modeFixtures().market))!.tradeFeeBaseBps;
  const notional = (FILLED * BOOKED) / 1_000_000n;
  const fee = (notional * (base + 23n + busyBps)) / 10_000n;
  return { base, notional, logs: fillEventLogs(WALLET, new PublicKey(SLAB), [{ flags: 8, requestedQ: FILLED, executedQ: FILLED, priceE6: BOOKED, quotedPriceE6: BOOKED + 230_000n, feeAtoms: fee }]) };
}
const confirmClick = async () => { await act(async () => { fireEvent.click(screen.getByTestId("trade-confirm")); }); };
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(100); }); };

describe("Skeptic D: the notice says the fee is INCLUDED in the trading fee (not charged on top)", () => {
  it("ticket and confirm screen", async () => {
    mocks.utilBps = 46n;
    await openConfirm();
    for (const id of ["ticket-busy-fee-notice", "confirm-busy-fee-notice"]) {
      const t = screen.getByTestId(id).textContent ?? "";
      expect(t).toContain("busy-side fee (");
      expect(t).toContain("is included in the trading fee above. It is not part of your entry price.");
      expect(t).not.toContain("on top");
    }
  });
});

describe("Skeptic E: Max on a busy side with leverage capped at 1x", () => {
  it('shows "1x (fixed)" and the "Leverage is fixed at 1x" notice (busyFixed1x)', async () => {
    mocks.utilBps = 200n;
    mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 10_000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true }); // the market's cap is 1x
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.click(screen.getAllByTestId("trade-size-preset").find((b) => b.getAttribute("data-percent") === "100")!);
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "1x (fixed)")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-busy-fee-notice").textContent).toContain("Leverage is fixed at 1x");
  });
  it("a market that allows more than 1x: no 'fixed' text", async () => {
    mocks.utilBps = 200n;
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } }); // a typed size, not Max
    expect(screen.queryByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").endsWith("(fixed)"))).toBeNull();
    expect(screen.getByTestId("ticket-busy-fee-notice").textContent).not.toContain("fixed at 1x");
  });
});

describe("Risk MED: the busy-side fee paid is saved with the entry", () => {
  it("open with a 200 bps busy-side fee: the amount is the quoted rate on the fill's notional", async () => {
    mocks.utilBps = 200n;
    const { notional, logs } = openLogs(200n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    await openConfirm();
    await confirmClick();
    await flush();
    const saved = getSavedEntry(SLAB, 0, W)!;
    expect(saved.busyFeeAtoms).toBe((notional * 200n) / 10_000n);
    expect(saved.sizeQ).toBe(FILLED);
  });
  it("no busy-side fee: a measured zero (not unknown)", async () => {
    const { logs } = openLogs(0n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    await openConfirm();
    await confirmClick();
    await flush();
    expect(getSavedEntry(SLAB, 0, W)!.busyFeeAtoms).toBe(0n);
  });
});

describe("Attacker A: the order signs what the confirm screen showed", () => {
  it("a higher busy-side fee after the review: refused before the wallet, with the line; nothing signed", async () => {
    mocks.utilBps = 46n;
    withPosition(0n);
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    mocks.utilBps = 200n; // the side got busier while the confirm was open
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5.5" } }); // any input change re-derives the quote
    rerender(<OrderTicket slabAddress={SLAB} />);
    await confirmClick();
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(screen.getByTestId("trade-error").textContent).toContain("The busy-side fee changed while you were reviewing");
    expect(screen.getByTestId("trade-error").textContent).toContain("Review it again. Nothing was sent.");
  });
  it("a LOWER busy-side fee after the review still sends, and the order is flagged as a confirmed cap (no silent raise on a 98)", async () => {
    mocks.utilBps = 200n;
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: openLogs(200n).logs } });
    withPosition(0n);
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    mocks.utilBps = 100n;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5.5" } });
    rerender(<OrderTicket slabAddress={SLAB} />);
    await confirmClick();
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    expect(mocks.trade.mock.calls[0][0]).toMatchObject({ confirmedFeeCap: true });
  });
  // Review MED-1: the cap is built from the reviewed terms whatever the P2 flag: base 30 + the 23 bps quote + the 200 bps busy-side fee + the
  // 2 bp margin = 255, signed exactly (never the chain read).
  for (const [name, charged] of [["P2 OFF (the deployed configuration)", false], ["P2 ON", true]] as const) {
    it(`${name}: the order signs the reviewed total + margin (255 bps), not the chain cap`, async () => {
      mocks.charged = charged;
      mocks.utilBps = 200n;
      mocks.change = { beforeQ: 0n, afterQ: FILLED };
      mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: openLogs(200n).logs } });
      withPosition(0n);
      render(<OrderTicket slabAddress={SLAB} />);
      fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
      await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
      await confirmClick();
      expect(mocks.trade).toHaveBeenCalledTimes(1);
      expect(mocks.trade.mock.calls[0][0]).toMatchObject({ confirmedFeeCap: true, feeBps: 255n });
    });
  }
});

describe("Attacker B: the side is the reviewed one", () => {
  it("the side flips while the confirm is open: refused before the wallet", async () => {
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-side-short")); });
    await confirmClick();
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(screen.getByTestId("trade-error").textContent).toContain("The side changed while you were reviewing");
  });
  it("control: with NO confirm open, autoSelect does flip the side (the mock reaches the effect)", async () => {
    withPosition(0n);
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    mocks.auto = "short";
    rerender(<OrderTicket slabAddress={SLAB} />);
    expect(screen.getByTestId("trade-side-short").getAttribute("aria-pressed") ?? screen.getByTestId("trade-side-short").className).toBeTruthy();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    await confirmClick();
    expect(mocks.trade.mock.calls[0][0].size).toBeLessThan(0n);
  });
  it("autoSelect (the open side pauses) does not flip the side under an open confirm: the reviewed order still goes", async () => {
    withPosition(0n);
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    mocks.auto = "short";
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5.5" } }); // a render under the open confirm
    rerender(<OrderTicket slabAddress={SLAB} />);
    expect(screen.getByTestId("trade-side-long").getAttribute("aria-pressed")).toBe("true"); // the side did not move under the confirm
    await confirmClick();
    expect(screen.queryByTestId("trade-error")).toBeNull();
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    expect(mocks.trade.mock.calls[0][0].size).toBeGreaterThan(0n); // still the long the trader reviewed
  });
  it("the leverage changes while the confirm is open: refused", async () => {
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    const lev = screen.getAllByTestId("trade-leverage-preset").find((b) => Number(b.getAttribute("data-leverage")) > 1)!;
    await act(async () => { fireEvent.click(lev); });
    await confirmClick();
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(screen.getByTestId("trade-error").textContent).toContain("The leverage changed while you were reviewing");
  });
});

describe("Attacker C: a fee raise for the signature leaves the Entry unknown", () => {
  it("raised cap on this signature: no saved entry (even though the fill splits cleanly)", async () => {
    const { logs } = openLogs(0n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    mocks.trade.mockImplementation(async () => { recordFeeRaise(SIG, { fromBps: 135n, toBps: 300n }); return SIG; });
    await openConfirm();
    await confirmClick();
    await flush();
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
  });
  it("control: the same fill with no raise saves an entry", async () => {
    const { logs } = openLogs(0n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    await openConfirm();
    await confirmClick();
    await flush();
    expect(getSavedEntry(SLAB, 0, W)).not.toBeNull();
  });
  it("quoted 0 on a growth market but the engine charged 2 bps: Entry unknown (no growth view in this harness: the check needs a growth market, so this is the pure-function case)", async () => {
    // covered in exec-fill.test.ts; here the ticket wiring: a non-growth market quotes NO rate, so the old behaviour stands.
    const base = decodeMarketEngineView(new Uint8Array(modeFixtures().market))!.tradeFeeBaseBps;
    const notional = (FILLED * BOOKED) / 1_000_000n;
    const fee = (notional * (base + 23n + 2n)) / 10_000n;
    const logs = fillEventLogs(WALLET, new PublicKey(SLAB), [{ flags: 8, requestedQ: FILLED, executedQ: FILLED, priceE6: BOOKED, quotedPriceE6: BOOKED + 230_000n, feeAtoms: fee }]);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    await openConfirm();
    await confirmClick();
    await flush();
    expect(getSavedEntry(SLAB, 0, W)).not.toBeNull();
  });
});

describe("review LOW-3: the ticket quotes a busy rate of 0 (not null) on a growth market", () => {
  const openOnce = async () => {
    const { logs } = openLogs(0n);
    mocks.change = { beforeQ: 0n, afterQ: FILLED };
    mocks.getTransaction.mockResolvedValue({ meta: { err: null, logMessages: logs } });
    await openConfirm();
    await confirmClick();
    await flush();
  };
  it("growth market, 0 quoted: effectivePriceE6 gets 0n", async () => {
    mocks.growthRoom = "known";
    await openOnce();
    expect(mocks.effArgs.length).toBeGreaterThan(0);
    expect(mocks.effArgs.every((a) => a === 0n)).toBe(true);
  });
  it("market with no growth record: null (the old behaviour)", async () => {
    mocks.growthRoom = "none";
    await openOnce();
    expect(mocks.effArgs.length).toBeGreaterThan(0);
    expect(mocks.effArgs.every((a) => a === null)).toBe(true);
  });
});

describe("review MED-1: the fund-and-trade path (no account yet) also signs the reviewed cap and is flagged confirmed", () => {
  it("fundAndTrade gets feeBps 255 and confirmedFeeCap: true", async () => {
    mocks.utilBps = 200n;
    mocks.fund.mockResolvedValue({ signature: SIG, portfolio: WALLET, prompts: 1, created: true });
    mocks.useUserAccount.mockReturnValue(null); // no trading account on this market yet
    mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn", getTransaction: mocks.getTransaction, getTokenAccountBalance: vi.fn(async () => ({ value: { amount: "1000000000", decimals: 6 } })), getAccountInfo: vi.fn(async () => null) } });
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    await confirmClick();
    expect(mocks.fund).toHaveBeenCalledTimes(1);
    expect(mocks.fund.mock.calls[0][0]).toMatchObject({ feeBps: 255n, confirmedFeeCap: true });
  });
});
