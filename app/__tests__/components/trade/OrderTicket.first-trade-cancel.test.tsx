/**
 * GH#2959: a first fund-and-trade the user turns down in the wallet must leave a calm line in the
 * ticket ("Trade cancelled in your wallet."), never a silent reset. Other cancels stay quiet.
 */
import { WalletRequestClosedError } from "@/lib/v22/sign-guard";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bandView: null as unknown,
  scanPending: false,
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
  rawSnap: vi.fn(() => null as unknown),
  closable: vi.fn(() => ({ closable: false }) as { closable: boolean }),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => mocks.scanPending }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => mocks.bandView }));
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
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => mocks.rawSnap() }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => mocks.closable() }));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function wallet(amount: string) {
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount, decimals: 6 } }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rawSnap.mockReturnValue(null);
  mocks.closable.mockReturnValue({ closable: false });
  mocks.bandView = null;
  mocks.scanPending = false;
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
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });

async function place() {
  await act(async () => fireEvent.click(submit()));
  await act(async () => fireEvent.click(screen.getByTestId("confirm-trade")));
}

const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

describe("GH#2959 wallet rejection on the first trade", () => {
  it("no account: rejecting in the wallet shows 'Trade cancelled in your wallet.'", async () => {
    mocks.fund.mockRejectedValueOnce(rejected());
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
    expect(screen.getByTestId("status-line").dataset.kind).toBe("cancelled");
    expect(screen.getByTestId("status-line-body").textContent).toBe("Trade cancelled in your wallet.");
    // the ticket is usable again
    expect(submit().disabled).toBe(false);
  });

  it("NEGATIVE CONTROL: a funded account's plain trade rejected in the wallet stays quiet", async () => {
    mocks.useUserAccount.mockReturnValue({ account: { capital: 100_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    mocks.trade.mockRejectedValue(rejected());
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(mocks.trade).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(screen.queryByTestId("status-line")).toBeNull();
  });

  it("devnet: 'Why?' explains the usual cause, a wallet still on Mainnet (Phantom)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true, wallet: { adapter: { name: "Phantom" } } });
    try {
      mocks.fund.mockRejectedValueOnce(rejected());
      render(<OrderTicket slabAddress={SLAB} />);
      await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
      size("5");
      await place();
      await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
      const why = screen.getByTestId("status-line-why");
      expect(why.textContent).toContain("Why?");
      await act(async () => fireEvent.click(why));
      const details = screen.getByTestId("status-line-details").textContent ?? "";
      expect(details).toContain("probably still on Mainnet");
      expect(details).toContain("Testnet Mode");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RT5-2 round f: devnet + Solflare: a decline says cancelled with NO Phantom hint", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true, wallet: { adapter: { name: "Solflare" } } });
    try {
      mocks.fund.mockRejectedValueOnce(rejected());
      render(<OrderTicket slabAddress={SLAB} />);
      await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
      size("5");
      await place();
      await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
      expect(screen.getByTestId("status-line").textContent).toContain("Trade cancelled in your wallet.");
      const why = screen.queryByTestId("status-line-why");
      if (why) await act(async () => fireEvent.click(why)); // the generic Details toggle may exist; it must not carry the hint
      expect(document.body.textContent).not.toContain("Testnet Mode");
      expect(document.body.textContent).not.toContain("still on Mainnet");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RT5-2 round f: an expired popup (WalletRequestClosedError) shows the timeout copy, not cancelled, no Phantom hint", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true, wallet: { adapter: { name: "Phantom" } } });
    try {
      mocks.fund.mockRejectedValueOnce(new WalletRequestClosedError(rejected()));
      render(<OrderTicket slabAddress={SLAB} />);
      await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
      size("5");
      await place();
      await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
      const text = screen.getByTestId("status-line").textContent ?? "";
      expect(text).toContain("The wallet request timed out. Nothing was sent");
      expect(text).not.toContain("cancelled in your wallet");
      expect(document.body.textContent).not.toContain("Testnet Mode");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("NEGATIVE CONTROL: mainnet never shows the devnet wallet hint", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    try {
      mocks.fund.mockRejectedValueOnce(rejected());
      render(<OrderTicket slabAddress={SLAB} />);
      await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
      size("5");
      await place();
      await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
      const why = screen.queryByTestId("status-line-why");
      if (why) await act(async () => fireEvent.click(why));
      expect(screen.queryByText(/Testnet Mode/)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the line clears on the next submit", async () => {
    mocks.fund.mockRejectedValueOnce(rejected());
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
    await place();
    await waitFor(() => expect(mocks.fund).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Trade cancelled in your wallet.")).toBeNull();
  });
});

// ── RT5-2 round g: drive the REAL guardSign through the ticket's submit with the wallet-adapter's error shape ──────────────
import { WalletSignTransactionError } from "@solana/wallet-adapter-base";
import { Keypair, Transaction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import { __resetSignGuardForTest, guardSign, noteBlockhash } from "@/lib/v22/sign-guard";

describe("RT5-2 round g: an expired Solflare popup through guardSign -> the ticket", () => {
  const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const guardConn = { getGenesisHash: async () => DEVNET_GENESIS_HASH, isBlockhashValid: async () => ({ context: { slot: 1 }, value: true }) };
  let clock = 0;
  beforeEach(() => {
    __setDevnetV22ForTest(true); __resetSignGuardForTest();
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  /** What wallet-adapter's StandardWalletAdapter throws: WalletSignTransactionError(error?.message, error). */
  const wrap = (inner: Record<string, unknown>) => new WalletSignTransactionError(String(inner.message), inner);

  function fundThroughGuard(inner: Record<string, unknown>, waitMs: number) {
    mocks.fund.mockImplementationOnce(async () => {
      clock = 5_000_000;
      const tx = new Transaction(); tx.recentBlockhash = BH; tx.feePayer = Keypair.generate().publicKey;
      noteBlockhash(BH, "sendTx attempt 1 (+1 keypair signer)", guardConn, clock - 2_000, { commitment: "confirmed", lastValidBlockHeight: 1 });
      return guardSign({
        txs: [tx], via: "adapter signTransaction", connection: guardConn, chain: "solana:devnet", now: () => clock,
        sign: async () => { clock += waitMs; throw wrap(inner); },
      });
    });
  }
  async function run() {
    mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true, wallet: { adapter: { name: "Solflare" } } });
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
    const why = screen.queryByTestId("status-line-why");
    if (why) await act(async () => fireEvent.click(why));
    return document.body.textContent ?? "";
  }

  for (const [label, inner] of [
    ["code 4001", { code: 4001, message: "Transaction cancelled" }],
    ["code -32603", { code: -32603, message: "Transaction cancelled" }],
    ["no code", { message: "Transaction cancelled" }],
  ] as const) {
    it(`70 s then 'Transaction cancelled' (${label}) -> timeout copy, no Phantom hint`, async () => {
      fundThroughGuard({ ...inner }, 70_000);
      const text = await run();
      expect(text).toContain("The wallet request timed out");
      expect(text).not.toContain("cancelled in your wallet");
      expect(text).not.toContain("Testnet Mode");
    });
  }
  it("a quick decline (3 s, fresh blockhash) is still 'Trade cancelled', Solflare has no hint", async () => {
    fundThroughGuard({ code: 4001, message: "Transaction cancelled" }, 3_000);
    const text = await run();
    expect(text).toContain("Trade cancelled in your wallet.");
    expect(text).not.toContain("Testnet Mode");
  });
});

describe("MIN-1: the ticket refuses a sub-minimum leg BEFORE the wallet, naming the real minimum", () => {
  it("band min 100 USDC at 32.12 per lot: 3 lots is refused with '4 lots (about 128.47 USDC)'; nothing is sent", async () => {
    mocks.bandView = { assetIndex: 0, lotExp: 0, band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 100_000_000n, recoveryMinutes: 64 }, price: { markE6: 32_116_513n, targetE6: 32_116_513n, lagging: false, floorStuck: false, favourableCloseSide: null }, rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n } };
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("3");
    await place();
    await waitFor(() => expect(document.body.textContent).toContain("4 lots (about 128.47 USDC)"));
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Minimum position 128.47 USDC (4 lots)".replace(" (4 lots)", "")); // the notice states the same number
  });
});

describe("SILENT-1: a confirmed order that cannot reach the wallet always says why", () => {
  it("account scan still pending when the order is confirmed: a visible line, no wallet, no silent return", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    mocks.scanPending = true; // the account read starts again after the confirm modal opened (e.g. a refresh after the previous tx)
    await place();
    await waitFor(() => expect(document.body.textContent).toContain("Still loading your account on this market"));
    expect(mocks.fund).not.toHaveBeenCalled();
  });
});

describe("round i: the waiting ticket says how long, from the market account", () => {
  afterEach(() => { __setDevnetV22ForTest(null); });
  it("a 20 bps gap at cap 1 (20 slots) shows 'Price is catching up — about 15 seconds. Goes through automatically.' with Stop", async () => {
    __setDevnetV22ForTest(true);
    mocks.bandView = { assetIndex: 0, lotExp: 0, band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 1_000_000n, recoveryMinutes: 64 }, price: { capBpsPerSlot: 1n, markE6: 100_000_000n, targetE6: 100_200_000n, lagging: true, floorStuck: false, favourableCloseSide: "long" }, rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n } };
    mocks.fund.mockImplementationOnce(async (p: { onWaiting?: (w: boolean) => void }) => { p.onWaiting?.(true); await new Promise(() => {}); });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("trade-catchup-estimate")).not.toBeNull());
    expect(screen.getByTestId("trade-catchup-estimate").textContent).toContain("Price is catching up — about 15 seconds. Goes through automatically.");
    expect(screen.getByTestId("trade-catchup-estimate").textContent).toContain("Stop");
  });
  it("NEGATIVE: no band / no gap -> no estimate line (the old wait copy stays)", async () => {
    __setDevnetV22ForTest(true);
    mocks.bandView = null;
    mocks.fund.mockImplementationOnce(async (p: { onWaiting?: (w: boolean) => void }) => { p.onWaiting?.(true); await new Promise(() => {}); });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.getByTestId("trade-submit").textContent).toContain("Waiting for the latest price"));
    expect(screen.queryByTestId("trade-catchup-estimate")).toBeNull();
  });
});

describe("v2.2 QA: PROFIT SETTLING with capital 0 still reaches the Withdraw card", () => {
  const PF = new PublicKey("4yjoGo9NWMv8XCfV2CZgaP6RyjwxxV6XbvMzmR7Z8b3i");
  const flat = (capital: bigint, pnl: bigint) => mocks.useUserAccount.mockReturnValue({ idx: 0, pubkey: PF, account: { capital, pnl, positionSize: 0n, entryPrice: 0n, kind: 0 } });
  it("capital 0, released profit, wallet empty: a 'Claim profit' toggle opens the card on Withdraw", async () => {
    wallet("0");
    flat(0n, 515_025n);
    render(<OrderTicket slabAddress={SLAB} />);
    const t = await screen.findByTestId("withdraw-toggle");
    expect(t.textContent).toBe("Claim profit");
    expect(screen.queryByTestId("deposit-card")).toBeNull();
    await act(async () => fireEvent.click(t));
    expect(screen.queryByTestId("deposit-card")).not.toBeNull();
  });
  it("#3458: an empty closable account (capital 0, no profit, flat) gets a 'Close account' entry that opens the Withdraw card", async () => {
    wallet("0");
    flat(0n, 0n);
    mocks.rawSnap.mockReturnValue({ pubkey: PF, portfolio: { legs: [] } });
    mocks.closable.mockReturnValue({ closable: true });
    render(<OrderTicket slabAddress={SLAB} />);
    const t = await screen.findByTestId("withdraw-toggle");
    expect(t.textContent).toBe("Close account");
    expect(screen.queryByTestId("deposit-card")).toBeNull();
    await act(async () => fireEvent.click(t));
    expect(screen.queryAllByTestId("deposit-card")).toHaveLength(1);
  });
  it("NEGATIVE CONTROL (#3458): the scan says the account is NOT closable -> no entry", async () => {
    wallet("0");
    flat(0n, 0n);
    mocks.rawSnap.mockReturnValue({ pubkey: PF, portfolio: { legs: [] } });
    mocks.closable.mockReturnValue({ closable: false });
    render(<OrderTicket slabAddress={SLAB} />);
    await screen.findByTestId("deposit-submit");
    expect(screen.queryByTestId("withdraw-toggle")).toBeNull();
  });
  it("NEGATIVE CONTROL: capital 0 and no profit -> no toggle (nothing to claim)", async () => {
    wallet("0");
    flat(0n, 0n);
    render(<OrderTicket slabAddress={SLAB} />);
    await screen.findByTestId("deposit-submit");
    expect(screen.queryByTestId("withdraw-toggle")).toBeNull();
  });
  it("capital > 0 keeps the ordinary '− Withdraw' toggle", async () => {
    wallet("0");
    flat(5_000_000n, 0n);
    render(<OrderTicket slabAddress={SLAB} />);
    const t = await screen.findByTestId("withdraw-toggle");
    expect(t.textContent).toContain("Withdraw");
    expect(t.textContent).not.toContain("Claim");
  });
});

describe("v2.2 QA: a clipped (partial) fill says 'Partially filled' with filled vs requested, from the landed FILL event", () => {
  const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
  afterEach(() => { __setDevnetV22ForTest(null); });
  async function placeOrderWithLogs(flags: number, executed: bigint) {
    __setDevnetV22ForTest(true);
    const { fillEventLogs } = await import("../../helpers/fill-event-fixture");
    mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(), programId: WRAPPER });
    mocks.useConnectionCompat.mockReturnValue({
      connection: {
        getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "12000000", decimals: 6 } }),
        getTransaction: vi.fn().mockResolvedValue({ meta: { err: null, logMessages: fillEventLogs(WRAPPER, new PublicKey(SLAB), [{ flags, requestedQ: 5_000_000n, executedQ: executed }]) } }),
      },
    });
    mocks.fund.mockResolvedValue({ signature: "sigClipped", portfolio: new PublicKey("11111111111111111111111111111111"), prompts: 1, created: true });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
  }
  it("CLIPPED flag, 3.2 of 5 executed -> 'Partially filled' title and 'of' body", async () => {
    await placeOrderWithLogs(9, 3_200_000n);
    await waitFor(() => expect(screen.queryByTestId("limits-fill-result")?.getAttribute("data-kind")).toBe("partial"));
    const line = screen.getByTestId("limits-fill-result").textContent ?? "";
    expect(line).toContain("Partially filled");
    expect(line).toMatch(/Partially filled: .+ of .+/);
  });
  it("NEGATIVE CONTROL: no CLIPPED flag -> no partial line", async () => {
    await placeOrderWithLogs(8, 5_000_000n);
    await waitFor(() => expect(document.body.textContent).toContain("Order")); // the result line rendered
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("limits-fill-result")?.getAttribute("data-kind")).not.toBe("partial");
    expect(document.body.textContent).not.toContain("Partially filled");
  });
});

// ── T-15 (QA 2026-10-14): the expired-popup copy must survive the round-i catch-up wait + silent-retry wrapper ──────────────
describe("T-15: an expired Solflare popup after the price catch-up wait still shows the timeout copy", () => {
  const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const guardConn = { getGenesisHash: async () => DEVNET_GENESIS_HASH, isBlockhashValid: async () => ({ context: { slot: 1 }, value: true }) };
  beforeEach(() => {
    __setDevnetV22ForTest(true); __resetSignGuardForTest();
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.bandView = { assetIndex: 0, lotExp: 0, band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 1_000_000n, recoveryMinutes: 64 }, price: { capBpsPerSlot: 1n, markE6: 100_000_000n, targetE6: 100_200_000n, lagging: true, floorStuck: false, favourableCloseSide: "long" }, rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n } };
  });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });
  for (const innerError of [{ code: 4001, message: "Transaction cancelled" }, { message: "Transaction cancelled" }]) {
    it(`wait (onWaiting true/false) -> wallet opens -> 70 s -> ${JSON.stringify(innerError)} -> timeout copy, no retry popup`, async () => {
      let clock = 5_000_000;
      mocks.fund.mockImplementation(async (p: { onWaiting?: (w: boolean) => void }) => {
        p.onWaiting?.(true);
        p.onWaiting?.(false);
        const tx = new Transaction(); tx.recentBlockhash = BH; tx.feePayer = Keypair.generate().publicKey;
        noteBlockhash(BH, "sendTx attempt 1", guardConn, clock - 2_000, { commitment: "confirmed", lastValidBlockHeight: 1 });
        return guardSign({ txs: [tx], via: "adapter signTransaction", connection: guardConn, chain: "solana:devnet", now: () => clock, sign: async () => { clock += 70_000; throw new WalletSignTransactionError(String(innerError.message), innerError); } });
      });
      mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true, wallet: { adapter: { name: "Solflare" } } });
      vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
      render(<OrderTicket slabAddress={SLAB} />);
      await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
      size("5");
      await place();
      await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
      const text = document.body.textContent ?? "";
      expect(text).toContain("The wallet request timed out");
      expect(text).not.toContain("cancelled in your wallet");
      expect(mocks.fund).toHaveBeenCalledTimes(1);
    });
  }
});
