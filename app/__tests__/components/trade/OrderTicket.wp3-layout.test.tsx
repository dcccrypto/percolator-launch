/**
 * UX WP-3 (audit §3.3 / §4.2) jsdom half of the ACs; the fork-harness half is
 * e2e/fork-journeys/ux-wp3-ticket.spec.ts.
 *  AC1 in every state: ≤ 1 status-line in the ticket.
 *  AC2 exactly one visible max figure, equal to data-max-q converted to the input unit.
 *  AC3 ADL: the Open tab can't submit and shows no "Max long"; the ticket starts on Close.
 *  AC4 zero fill: status-line[data-kind=zero-fill], no "Tx:" outside Details.
 *  AC5 partial fill: data-variant=info.
 * Plus: side paused auto-selects the open side, the clamp helper, the long wait + Stop.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SideLimit = { maxQ: bigint; reason: string; halted: boolean };
const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  trade: vi.fn(),
  engineStale: false,
  adl: false,
  fill: null as null | { kind: "full" | "partial" | "zero" | "unknown"; filledQ: bigint | null },
  sideLimits: null as null | { long: SideLimit; short: SideLimit },
  sameOwner: false,
  limits: null as unknown,
  listeners: new Set<() => void>(),
}));
function setEngineStale(v: boolean) {
  mocks.engineStale = v;
  for (const l of mocks.listeners) l();
}

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", async () => {
  const React = await import("react");
  return {
    useEngineFreshness: () => ({
      engineStale: React.useSyncExternalStore(
        (l: () => void) => { mocks.listeners.add(l); return () => mocks.listeners.delete(l); },
        () => mocks.engineStale,
      ),
    }),
  };
});
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 2_000_000n, priceUsd: 2 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 2, priceE6: 2_000_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/limits/adl-reduce-only", () => ({ isAdlReduceOnly: () => mocks.adl }));
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<object>()), decodeMarketEngineView: () => ({}) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => mocks.fill }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: () => <div data-testid="close-panel" /> }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => (
    <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>
  ),
}));
vi.mock("@/lib/limits/ticket", async (orig) => {
  const real = await orig<typeof import("@/lib/limits/ticket")>();
  return {
    ...real,
    deriveTicketLimits: (i: Parameters<typeof real.deriveTicketLimits>[0]) => {
      const r = real.deriveTicketLimits(i);
      const sl = mocks.sideLimits;
      if (!sl) return r;
      return {
        ...r,
        sideLimits: sl,
        halted: { long: sl.long.halted, short: sl.short.halted },
        sameOwner: mocks.sameOwner,
        sameOwnerCloseOnly: mocks.sameOwner,
      };
    },
  };
});

import { OrderTicket } from "@/components/trade/OrderTicket";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const open = (maxQ: bigint, halted = false): SideLimit => ({ maxQ, reason: "lp-exposure", halted });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engineStale = false;
  mocks.adl = false;
  mocks.fill = null;
  mocks.sameOwner = false;
  mocks.limits = marketLimits({ state: "off" });
  // P1: long room 41.8834 SOL, short room 100 SOL (1e6 scale). $2 per SOL.
  mocks.sideLimits = { long: open(41_883_400n), short: open(100_000_000n) };
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: {} });
  // 10,000 USDC capital: the balance never binds before the market's cap at 1x.
  mocks.useUserAccount.mockReturnValue({ account: { capital: 10_000_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 0 });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"), raw: new Uint8Array(8),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => vi.useRealTimers());

const ticket = () => screen.getByTestId("order-ticket");
/**
 * Screenshot evidence (375 / 1440): with UX_SHOTS_OUT set, the REAL ticket markup of each state
 * is written out and scripts/ux-shots/shoot-html.mjs renders it with the app's compiled CSS.
 */
async function snap(name: string) {
  const out = process.env.UX_SHOTS_OUT;
  if (!out) return;
  const fs = await import("node:fs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/${name}.html`, ticket().outerHTML);
}
const lines = () => within(ticket()).queryAllByTestId("status-line");
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;

async function placeOrder(size = "10") {
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: size } });
  await act(async () => {
    fireEvent.click(submit());
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-trade"));
  });
}

describe("WP-3 AC1/AC2: live ticket", () => {
  it("live: no status line, ONE max figure in the input's unit, no legacy rows", async () => {
    mocks.limits = marketLimits({ vaultLp: null });
    render(<OrderTicket slabAddress={SLAB} />);
    expect(lines()).toHaveLength(0);
    const maxes = screen.getAllByTestId("limits-max-size-inline");
    expect(maxes).toHaveLength(1);
    const m = maxes[0];
    expect(m.dataset.side).toBe("long");
    expect(m.dataset.maxQ).toBe("41883400");
    // USD is the default unit: 41.8834 SOL × $2 = $83.76 (floored to cents)
    expect(m.textContent).toBe("Max $83.76");
    fireEvent.click(screen.getByTestId("trade-size-unit"));
    expect(screen.getByTestId("limits-max-size-inline").textContent).toBe("Max 41.8834 SOL");
    await snap("live");
    // the base symbol is the token, never "-PERP"
    expect(ticket().textContent).not.toMatch(/SOL-PERP/);
    // legacy / duplicate rows are gone; per-side rows live in Details only
    expect(ticket().textContent).not.toMatch(/Max per trade|capacity left|Order value|Market max \/ trade|Slippage bound/i);
    expect(screen.queryAllByTestId("limits-max-size")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("ticket-details-toggle"));
    expect(within(screen.getByTestId("ticket-details")).getAllByTestId("limits-max-size")).toHaveLength(2);
    // the button is the state: with no size it says what is missing, then it names the order
    expect(submit().textContent).toBe("Enter a size");
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(submit().textContent).toBe("Long SOL 1×");
  });

  it("the Max figure fills the size; Max chip = the same one max", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.click(screen.getByTestId("limits-max-size-inline"));
    expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("83.76");
    await snap("live-order");
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "" } });
    fireEvent.click(screen.getAllByTestId("trade-size-preset").find((b) => b.dataset.percent === "50")!);
    expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("41.88");
  });

  it("clamp (row 9): over the max the size is reduced and the helper says so; no status line", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "500" } });
    expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("83.76");
    const helper = screen.getByTestId("limits-clamp-notice");
    expect(helper.dataset.maxQ).toBe("41883400");
    expect(helper.textContent).toBe("Reduced to the most available now: $83.76 USD");
    expect(helper.className).toMatch(/--warning/);
    expect(lines()).toHaveLength(0);
    await snap("clamp");
    // an edit clears it
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(screen.queryByTestId("limits-clamp-notice")).toBeNull();
  });

  it("CONTROL: without a market cap there is no clamp and no market Max", () => {
    mocks.sideLimits = null;
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "500" } });
    expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("500");
    expect(screen.queryByTestId("limits-clamp-notice")).toBeNull();
    // the balance still bounds the figure: 10,000 USDC × 1x
    expect(screen.getByTestId("limits-max-size-inline").textContent).toBe("Max $10,000.00");
  });
});

describe("WP-3 states: at most one status line, the button names the state", () => {
  it("catching up: one wait line; re-enables itself", async () => {
    mocks.engineStale = true;
    render(<OrderTicket slabAddress={SLAB} />);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.kind).toBe("engine-catching-up");
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe("Waiting for prices…");
    await snap("catching-up");
    await act(async () => setEngineStale(false));
    expect(lines()).toHaveLength(0);
    expect(submit().textContent).toBe("Enter a size");
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(submit().textContent).toBe("Long SOL 1×");
  });

  it("side paused: the ticket selects the open side; the paused one says so and can't be picked", async () => {
    mocks.sideLimits = { long: open(0n, true), short: open(100_000_000n) };
    render(<OrderTicket slabAddress={SLAB} />);
    const long = screen.getByTestId("trade-side-long") as HTMLButtonElement;
    const short = screen.getByTestId("trade-side-short") as HTMLButtonElement;
    expect(short.getAttribute("aria-pressed")).toBe("true");
    expect(long.disabled).toBe(true);
    expect(long.dataset.limitsHalted).toBe("true");
    expect(within(long).getByTestId("trade-side-paused").textContent).toBe("Paused");
    expect(lines()).toHaveLength(0);
    expect(submit().textContent).toBe("Enter a size");
    expect(screen.getByTestId("limits-max-size-inline").dataset.side).toBe("short");
    await snap("side-paused");
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    expect(submit().textContent).toBe("Short SOL 1×");
  });

  it("both sides paused: one 'Opening paused' line, no Max", () => {
    mocks.sideLimits = { long: open(0n, true), short: open(0n, true) };
    render(<OrderTicket slabAddress={SLAB} />);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.kind).toBe("both-paused");
    expect(submit().textContent).toBe("Opening paused");
    expect(screen.queryByTestId("limits-max-size-inline")).toBeNull();
  });

  it("same-owner: one line, 'Close-only for this wallet'", async () => {
    mocks.sameOwner = true;
    mocks.sideLimits = { long: { maxQ: 0n, reason: "same-owner", halted: false }, short: { maxQ: 0n, reason: "same-owner", halted: false } };
    render(<OrderTicket slabAddress={SLAB} />);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.kind).toBe("same-owner");
    expect(submit().textContent).toBe("Close-only for this wallet");
    expect(submit().disabled).toBe(true);
    await snap("same-owner");
  });

  it("AC3 close-only (ADL): starts on Close; the Open tab can't submit and shows no max", async () => {
    mocks.adl = true;
    render(<OrderTicket slabAddress={SLAB} />);
    expect(screen.getByTestId("close-panel")).toBeTruthy();
    const closeNotes = within(ticket()).queryAllByTestId("status-line");
    expect(closeNotes.length).toBeLessThanOrEqual(1);
    expect(ticket().textContent).not.toMatch(/RebalanceReduce|unilateral/i);
    fireEvent.click(screen.getAllByTestId("trade-mode-tab").find((t) => t.dataset.mode === "open")!);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.kind).toBe("close-only");
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe("Close-only for now");
    expect(screen.queryByTestId("limits-max-size-inline")).toBeNull();
    expect(ticket().textContent).not.toMatch(/Max long/i);
    await snap("close-only");
  });
});

describe("WP-3 result lines", () => {
  it("AC4 zero fill: status-line[data-kind=zero-fill] + 'Try' chip; the tx only inside Details", async () => {
    mocks.trade.mockResolvedValueOnce("5igSigZero1111111111111111111111111111111111111");
    mocks.fill = { kind: "zero", filledQ: 0n };
    render(<OrderTicket slabAddress={SLAB} />);
    await placeOrder("10");
    expect(lines()).toHaveLength(1);
    const line = lines()[0];
    expect(line.dataset.kind).toBe("zero-fill");
    expect(line.closest("[data-testid=limits-fill-result]")?.getAttribute("data-kind")).toBe("zero");
    expect(within(line).getByTestId("status-line-body").textContent).toMatch(/^Not filled: the market had no room/);
    expect(within(line).getByTestId("status-line-action").textContent).toMatch(/^Try /);
    expect(ticket().textContent).not.toMatch(/Tx:|Confirmed!/);
    expect(screen.queryByTestId("status-line-tx")).toBeNull();
    await snap("zero-fill");
    fireEvent.click(within(line).getByTestId("status-line-why"));
    expect(screen.getByTestId("status-line-tx").getAttribute("href")).toContain("5igSigZero");
  });

  it("AC5 partial: data-variant=info, 'Opened X of Y SOL'", async () => {
    mocks.trade.mockResolvedValueOnce("sigPartial");
    mocks.fill = { kind: "partial", filledQ: 2_000_000n };
    render(<OrderTicket slabAddress={SLAB} />);
    await placeOrder("10"); // $10 at $2 = 5 SOL
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.variant).toBe("info");
    expect(lines()[0].dataset.kind).toBe("partial-fill");
    expect(screen.getByTestId("status-line-body").textContent).toBe("Opened 2 of 5 SOL. The market had room for part of your order.");
    await snap("partial");
    expect(ticket().textContent).not.toMatch(/Confirmed!/);
  });

  it("full fill: 'Opened 5 SOL long at $2.00'", async () => {
    mocks.trade.mockResolvedValueOnce("sigFull");
    render(<OrderTicket slabAddress={SLAB} />);
    await placeOrder("10");
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.kind).toBe("filled");
    expect(screen.getByTestId("status-line-body").textContent).toMatch(/^Opened 5 SOL long at \$2\.0+$/);
  });

  // An Open-tab order on the other side of an 8 SOL long cuts it first: the line says so.
  const withLong = (q: bigint) =>
    mocks.useUserAccount.mockReturnValue({ account: { capital: 10_000_000_000n, positionSize: q, entryPrice: 2_000_000n, pnl: 0n }, idx: 0 });
  const placeShort = async (size: string) => {
    fireEvent.click(screen.getByTestId("trade-side-short"));
    await placeOrder(size);
  };

  it.each([
    ["8000000", "10", /^Reduced your long by 5 SOL at \$2\.0+$/], // 5 SOL against an 8 SOL long
    ["5000000", "10", /^Closed your 5 SOL long at \$2\.0+$/],
    ["3000000", "10", /^Closed your 3 SOL long and opened 2 SOL short at \$2\.0+$/],
  ])("against a %s long, a $%s short reads as what it did", async (pos, size, want) => {
    withLong(BigInt(pos));
    mocks.trade.mockResolvedValueOnce("sigCut");
    render(<OrderTicket slabAddress={SLAB} />);
    await placeShort(size);
    expect(screen.getByTestId("status-line-body").textContent).toMatch(want);
  });

  it("an unmeasured fill never claims the full size opened", async () => {
    mocks.trade.mockResolvedValueOnce("sigUnknown");
    mocks.fill = { kind: "unknown", filledQ: null };
    render(<OrderTicket slabAddress={SLAB} />);
    await placeOrder("10");
    expect(screen.getByTestId("status-line-body").textContent).toBe("Order went through. Your position updates in a moment.");
    expect(lines()[0].dataset.kind).toBe("sent");
    expect(lines()[0].textContent).toMatch(/Order sent/);
    expect(lines()[0].textContent).not.toMatch(/Order filled/);
  });
});

describe("WP-3 long wait: 'We'll keep trying' + Stop, never 'try again'", () => {
  it("after ~30 s the slot offers Stop; Stop ends the wait quietly", async () => {
    mocks.trade.mockImplementationOnce(
      (p: { onWaiting?: (w: boolean) => void; onWaitingLong?: () => void; abortSignal?: AbortSignal; keepWaiting?: boolean }) =>
        new Promise((_res, rej) => {
          expect(p.keepWaiting).toBe(true);
          p.onWaiting?.(true);
          p.onWaitingLong?.();
          p.abortSignal?.addEventListener("abort", () => {
            p.onWaiting?.(false);
            rej(Object.assign(new Error("Stopped waiting for the market; nothing was sent."), { name: "WaitStoppedError" }));
          });
        }),
    );
    render(<OrderTicket slabAddress={SLAB} />);
    await placeOrder("10");
    expect(submit().textContent).toBe("Waiting for the latest price…");
    expect(lines()).toHaveLength(1);
    expect(lines()[0].dataset.kind).toBe("waiting-long");
    expect(ticket().textContent).not.toMatch(/try again/i);
    await act(async () => {
      fireEvent.click(screen.getByTestId("status-line-action"));
    });
    expect(lines()).toHaveLength(0);
    expect(submit().textContent).toBe("Long SOL 1×");
  });
});
