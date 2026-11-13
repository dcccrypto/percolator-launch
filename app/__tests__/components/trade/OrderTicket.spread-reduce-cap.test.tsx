/**
 * Review of #3820: (a) the ticket passes the REDUCING flag of its own order to the spread quoter; (b) with the P2 flag OFF (the preview's
 * configuration: no ticket quote, no ticket fee) the Fee row, Est. fill and the confirm's fee show the size-aware spread from the quoter (+ the margin);
 * (c) with P2 on, Est. fill reads the SAME rounded quote as the Fee row. The REAL ticket mounts the REAL confirm modal.
 * What is signed is NOT asserted here: on v2.2 useTrade signs the chain's worst-case cap (round 9 behaviour), unchanged by this PR.
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
  charged: false,
  quoterNull: false,
  quoteTotal: null as null | bigint,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useSpreadQuoter", () => ({
  useSpreadQuoter: () => (size: bigint, buys: boolean, reducing?: boolean) => { mocks.quoterCalls.push([size, buys, reducing]); if (mocks.quoterNull) return null; return { kind: "quote", bps: mocks.quoteBps, execPriceE6: null, inFee: true }; },
}));
// The ticket's own fee read: a fee-channel market whose signed cap the test moves between the review and the click.
vi.mock("@/lib/limits/ticket", async (orig) => {
  const m = await orig<typeof import("@/lib/limits/ticket")>();
  return { ...m, deriveTicketLimits: (i: Parameters<typeof m.deriveTicketLimits>[0]) => { const r = m.deriveTicketLimits(i); return mocks.cap === null ? r : { ...r, ...(mocks.quoteTotal !== null ? { quote: { ...(r.quote ?? {}), totalBps: mocks.quoteTotal } as unknown as NonNullable<typeof r.quote> } : {}), fee: { channel: { enabled: true, protocolMaxBps: 100 }, signedFeeBps: mocks.cap, requestedBps: 23n, marginBps: 2n, verdict: "ok" as const, charged: mocks.charged } }; } };
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
  mocks.charged = false;
  mocks.quoterNull = false;
  mocks.quoteTotal = null;
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

const cellValue = (label: string) => (screen.getByText(label).closest("div") as HTMLElement).textContent ?? "";

describe("P2 OFF (the preview): the size-aware spread is what the ticket shows", () => {
  it("Fee row = base 30 + the quoter's 38 + the 2 bp margin = 70 bps; Est. fill = mark moved by 40 bps; the confirm's fee is the same 70 bps", async () => {
    mocks.quoteBps = 38; // the quoter's per-size read (the ticket has no quote of its own with P2 off: mocks.cap = null)
    await typeSize("5");
    // a 5 USDC order: 70 bps = 0.035 (shown 0.034999)
    expect(cellValue("Fee (est.)")).toMatch(/0\.0349/);
    expect(cellValue("Est. fill")).toMatch(/1\.2048/); // 1.20 x (1 + 40 bps) rounded up
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    expect(screen.getByText("Trading Fee (est.):").parentElement?.textContent).toMatch(/0\.0349/);
  });
  it("a bigger quote moves all of them together (the spread follows the size the quoter was asked for)", async () => {
    mocks.quoteBps = 60;
    await typeSize("5");
    expect(cellValue("Fee (est.)")).toMatch(/0\.0459/); // 92 bps of 5
    expect(cellValue("Est. fill")).toMatch(/1\.2074/); // 62 bps
  });
});

describe("P2 ON: Est. fill reads the Fee row's own rounded quote, not a different one", () => {
  it("ticket quote 23 bps (fee.requestedBps) vs the quoter's 40: Est. fill and the Fee row both use 23 + 2", async () => {
    mocks.cap = 70n;
    mocks.charged = true;
    mocks.quoteBps = 40; // must NOT be what Est. fill shows
    await typeSize("5");
    expect(cellValue("Est. fill")).toMatch(/1\.203/);
    expect(cellValue("Est. fill")).not.toMatch(/1\.2048/);
    expect(cellValue("Fee (est.)")).toMatch(/0\.0274/); // (30 + 23 + 2) bps of 5 = 0.0275
  });
  it("Est. fill follows fee.requestedBps (23), not a different quote.totalBps (22) the same limits object carries (review of #3820 delta 2, LOW 2; M13b)", async () => {
    mocks.cap = 70n;
    mocks.charged = true;
    mocks.quoteTotal = 22n;
    mocks.quoteBps = 40;
    await typeSize("5");
    expect(cellValue("Est. fill")).toMatch(/1\.203/); // 1.20 x (1 + (23 + 2) bps) = 1.2030; with 22 it would read 1.20264 (rounded up: 1.202641)
    expect(cellValue("Est. fill")).not.toMatch(/1\.2026/);
    expect(cellValue("Fee (est.)")).toMatch(/0\.0274/);
  });
  it("the quoter has no answer while the ticket's own fee is charged: the Fee row still carries the margin, so it agrees with Est. fill (review of #3820 delta 2, LOW 1)", async () => {
    mocks.cap = 70n;
    mocks.charged = true;
    mocks.quoterNull = true;
    await typeSize("5");
    expect(cellValue("Est. fill")).toMatch(/1\.203/); // +25 bps (23 + 2)
    expect(cellValue("Fee (est.)")).toMatch(/0\.0274/); // 55 bps of 5, margin included (it was 53 bps: 0.0264)
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    expect(screen.getByText("Trading Fee (est.):").parentElement?.textContent).toMatch(/0\.0274/);
  });
  it("the trader's own margin is used in the figures: the ticket's margin (10 bp, set at mount) moves Est. fill and the Fee row by 10, not the env default 2", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEE_CAP_MARGIN_BPS", "10");
    mocks.quoteBps = 38;
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />); // the margin state is read here
    vi.unstubAllEnvs(); // the default is 2 again from now on: only the ticket's own value can give 10
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(cellValue("Est. fill")).toMatch(/1\.20576/); // 48 bps
    expect(cellValue("Fee (est.)")).toMatch(/0\.0389/); // 78 bps of 5
  });
  it("the confirm's fee uses the trader's margin too (10 bp: 30 + 38 + 10 = 78 bps), not the env default (review of #3820 delta 2, LOW 3; M19)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEE_CAP_MARGIN_BPS", "10");
    mocks.quoteBps = 38;
    withPosition(0n);
    render(<OrderTicket slabAddress={SLAB} />);
    vi.unstubAllEnvs();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    expect(screen.getByText("Trading Fee (est.):").parentElement?.textContent).toMatch(/0\.0389/); // 78 bps of 5; the default 2 would give 0.0349
  });
});
