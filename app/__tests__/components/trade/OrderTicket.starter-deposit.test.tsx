/**
 * UX WP-6 (audit §3.2): the first trade in ONE approval from the order ticket.
 *  - no account yet + sim-USDC in the wallet: the ticket is usable; the button reads
 *    "Deposit {x} & Long" with "First trade on this market sets up your trading account (one
 *    approval)"; submitting calls fundAndTrade (A [InitUser] + B [Deposit, Trade], one prompt);
 *  - the deposit is editable; over the wallet balance: inline error, "Get test funds", nothing
 *    signed (the old starter-deposit guarantee, kept);
 *  - a failed deposit leg is shown (never swallowed) with a "Deposit {x}" next step;
 *  - a returning user short of margin: "Deposit {x} & Long" = one tx [Deposit, Trade].
 * The BPF half is limits_app_first_trade_one_signature_and_race (scripts/limits-parity/p3-sim).
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
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
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

describe("first trade, one approval", () => {
  it("no account + tokens in the wallet: one button 'Deposit {x} & Long' and the one-approval line", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5"); // $5 at 1x: margin 5, fee 0.015 => deposit (5.015) * 1.1 = 5.52 (cent up)
    expect(screen.getByTestId("first-trade-line").textContent).toBe("First trade on this market sets up your trading account (one approval)");
    expect(submit().textContent).toBe("Deposit 5.52 USDC & Long");
    expect(submit().disabled).toBe(false);
    expect(screen.queryByTestId("deposit-submit")).toBeNull(); // the old 2-step "Start Trading" CTA is gone
    await snap("first-trade");
    await place();
    expect(mocks.fund).toHaveBeenCalledTimes(1);
    expect(mocks.fund.mock.calls[0][0]).toMatchObject({ size: 5_000_000n, depositAtoms: 5_520_000n, amountLabel: "5.52 USDC" });
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(mocks.initUser).not.toHaveBeenCalled();
  });

  it("the deposit is editable; over the wallet: inline error, 'Get test funds', nothing signed", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    fireEvent.change(screen.getByTestId("deposit-amount-input"), { target: { value: "5000" } });
    expect(screen.getByTestId("starter-deposit-error").textContent).toMatch(/exceeds your wallet balance/i);
    expect(submit().textContent).toBe("Get test funds");
    await snap("over-wallet");
    await act(async () => fireEvent.click(submit()));
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(screen.getByTestId("deposit-card")).toBeTruthy(); // get funds instead
    // Max = the wallet balance, and the error clears
    fireEvent.click(screen.getByRole("button", { name: /deposit full wallet balance/i }));
    expect((screen.getByTestId("deposit-amount-input") as HTMLInputElement).value).toBe("12");
    expect(screen.queryByTestId("starter-deposit-error")).toBeNull();
    expect(submit().textContent).toBe("Deposit 12.00 USDC & Long");
  });

  it("CONTROL: less than the order needs is refused before signing", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    fireEvent.change(screen.getByTestId("deposit-amount-input"), { target: { value: "1" } });
    expect(screen.getByTestId("first-trade-deposit-too-small")).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it("a failed deposit leg is shown, with the next step (never swallowed)", async () => {
    mocks.fund.mockRejectedValueOnce(new FirstTradeDepositError("5.52 USDC", new Error("insufficient funds")));
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    const line = screen.getByTestId("status-line");
    expect(line.dataset.kind).toBe("first-trade-deposit");
    expect(screen.getByTestId("status-line-body").textContent).toMatch(
      /^Your trading account is set up but the deposit didn't go through\. Deposit 5\.52 USDC to trade\./,
    );
    expect(screen.getByTestId("status-line-action").textContent).toBe("Deposit 5.52 USDC");
    await snap("deposit-failed");
    await act(async () => fireEvent.click(screen.getByTestId("status-line-action")));
    expect(screen.getByTestId("deposit-card")).toBeTruthy();
  });

  // The entry cache (lib/entry-price.ts) is the only source of Entry / PnL / ROE for a new position.
  // The first fund-and-trade runs with no account in handleTrade's closure, and the save was gated
  // on that account, so a new user's first position showed Entry "—" and PnL "--".
  it("the first fund-and-trade records the entry (v17 idx 0, this wallet)", async () => {
    localStorage.clear();
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    expect(mocks.fund).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(localStorage.getItem(`perc:entry:${SLAB}:0:11111111111111111111111111111111`) ?? "null");
    expect(rec?.entryPriceE6).toBe("1000000");
  });

  it("CONTROL: a returning user's fund-and-trade still keys the entry by their account idx", async () => {
    localStorage.clear();
    mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    expect(localStorage.getItem(`perc:entry:${SLAB}:3:11111111111111111111111111111111`)).not.toBeNull();
    expect(localStorage.getItem(`perc:entry:${SLAB}:0:11111111111111111111111111111111`)).toBeNull();
  });

  it("a returning user short of margin: 'Deposit {x} & Long' = one tx [Deposit, Trade]", async () => {
    mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5"); // needs 5 + fee, has 1 => deposit (4 + 0.015) * 1.1 = 4.42
    expect(screen.queryByTestId("first-trade-line")).toBeNull();
    expect(submit().textContent).toBe("Deposit 4.42 USDC & Long");
    await place();
    expect(mocks.fund.mock.calls[0][0]).toMatchObject({ depositAtoms: 4_420_000n });
  });

  it("Squid 2026-10-01: a returning user's Available and Max count the wallet, not just the old deposit", async () => {
    mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.getByTestId("ticket-available").textContent).not.toMatch(/Available 1\.00 /));
    const avail = Number(screen.getByTestId("ticket-available").textContent!.replace(/[^0-9.]/g, ""));
    expect(avail).toBe(13); // the real money: 1 in-market + 12 in the wallet (2026-10-02: never wallet / 1.1)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^max$/i })));
    expect(submit().textContent).toMatch(/^Deposit [0-9.]+ USDC & Long$/);
    expect(submit().disabled).toBe(false);
    await place();
    const dep = mocks.fund.mock.calls[0][0].depositAtoms as bigint;
    expect(dep).toBeGreaterThan(11_000_000n);
    expect(dep).toBeLessThanOrEqual(12_000_000n);
    expect(screen.queryByTestId("starter-deposit-error")).toBeNull();
  });

  it("CONTROL: nothing in the wallet — the ticket stays locked behind 'Get Tokens to Trade'", async () => {
    wallet("0");
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.getByTestId("deposit-submit").textContent).toBe("Get Tokens to Trade"));
    expect(screen.queryByTestId("trade-submit")).toBeNull();
  });
});

describe("the typed deposit is reset with the rest of the ticket", () => {
  const depositInput = () => screen.getByTestId("deposit-amount-input") as HTMLInputElement;

  it("switching market clears it, so the new market uses its own computed amount", async () => {
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    fireEvent.change(depositInput(), { target: { value: "9" } });
    expect(submit().textContent).toBe("Deposit 9.00 USDC & Long");
    rerender(<OrderTicket slabAddress="ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ" />);
    size("5");
    expect(depositInput().value).toBe("");
    expect(submit().textContent).toBe("Deposit 5.52 USDC & Long");
  });

  it("a successful first trade clears it", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    fireEvent.change(depositInput(), { target: { value: "9" } });
    await place();
    expect(mocks.fund.mock.calls[0][0]).toMatchObject({ depositAtoms: 9_000_000n });
    size("5");
    expect(depositInput().value).toBe("");
    expect(submit().textContent).toBe("Deposit 5.52 USDC & Long");
  });
});
