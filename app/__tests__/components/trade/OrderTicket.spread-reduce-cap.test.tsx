/**
 * Review of #3820 (HIGH 1, MED 2): the ticket passes the REDUCING flag of its own order to the spread quoter, and a confirmed order signs the fee
 * cap that was shown when the confirm opened: a cap that rises afterwards is never signed silently (the wrapper then refuses with 98 and the
 * trader reviews again). The REAL ticket mounts the REAL confirm modal.
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
  quoterCalls: [] as Array<[bigint, boolean, boolean | undefined]>,
  cap: null as null | bigint,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useSpreadQuoter", () => ({
  useSpreadQuoter: () => (size: bigint, buys: boolean, reducing?: boolean) => { mocks.quoterCalls.push([size, buys, reducing]); return { kind: "quote", bps: mocks.quoteBps, execPriceE6: null, inFee: true }; },
}));
// The ticket's own fee read: a fee-channel market whose signed cap the test moves between the review and the click.
vi.mock("@/lib/limits/ticket", async (orig) => {
  const m = await orig<typeof import("@/lib/limits/ticket")>();
  return { ...m, deriveTicketLimits: (i: Parameters<typeof m.deriveTicketLimits>[0]) => { const r = m.deriveTicketLimits(i); return mocks.cap === null ? r : { ...r, fee: { channel: { enabled: true, protocolMaxBps: 100 }, signedFeeBps: mocks.cap, requestedBps: 23n, marginBps: 2n, verdict: "ok" as const, charged: false } }; } };
});
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
  mocks.cap = null;
  mocks.quoterCalls.length = 0;
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


const confirmClick = async () => { await act(async () => { fireEvent.click(screen.getByTestId("trade-confirm")); }); };

describe("the ticket's spread quote is asked as a reduce only when the order reduces the position", () => {
  it("a flat account: not reducing", async () => {
    await typeSize();
    expect(mocks.quoterCalls.length).toBeGreaterThan(0);
    for (const c of mocks.quoterCalls) expect(c[2]).toBe(false);
  });
  it("a long position and a sell smaller than it: reducing = true", async () => {
    withPosition(1_000_000_000_000n);
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.click(screen.getByTestId("trade-side-short"));
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    const sells = mocks.quoterCalls.filter((c) => !c[1]);
    expect(sells.length).toBeGreaterThan(0);
    for (const c of sells) expect(c[2]).toBe(true);
  });
});

describe("MED 2: the confirmed order signs the cap shown at review", () => {
  it("the live cap rises after the confirm opened: the reviewed cap is signed, not the new one", async () => {
    mocks.cap = 70n;
    await openConfirm();
    mocks.cap = 95n; // the quote / volatility moved while the confirm was open
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5.5" } }); // the ticket re-derives
    await confirmClick();
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    expect(mocks.trade.mock.calls[0][0].feeBps).toBe(70n);
    expect(mocks.trade.mock.calls[0][0]).toMatchObject({ confirmedFeeCap: true });
  });
  it("no fee channel quoted at review: no cap is signed, even if one appears afterwards", async () => {
    mocks.cap = null;
    await openConfirm();
    mocks.cap = 95n;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5.5" } });
    await confirmClick();
    expect(mocks.trade.mock.calls[0][0].feeBps).toBeUndefined();
  });
});
