/**
 * #3304: a position row in the dock offers "+ Margin" (before Close, owned row only), which opens the
 * existing AddMarginModal bound to THAT row's portfolio account.
 *
 * The real AddMarginModal and the real useDeposit run end to end; only the network edge is stubbed (the
 * connection, the v18 identity read and the transaction sender, which records the instructions it is
 * given). The deposit instruction is read back and its accounts and amount are asserted.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  wrapped: null as unknown,
  balance: 100_000_000n as bigint | null,
  sent: [] as Array<{ instructions: Array<{ keys: Array<{ pubkey: import("@solana/web3.js").PublicKey }>; data: Buffer }> }>,
  refresh: vi.fn(),
}));

const OWNER = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const SLAB = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const ROW_PK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");

const acct = (over: Record<string, unknown>, pubkey = ROW_PK) => ({
  idx: 0,
  pubkey,
  account: {
    kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n,
    entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => false }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({
  useNftWrappedPosition: (_slab: string, enabled: boolean) => (enabled ? h.wrapped : null),
}));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn(), resetPhase: vi.fn() }),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      // Doubles as the collateral token account for the deposit's balance read (u64 LE @ 64).
      getAccountInfo: vi.fn(async () => {
        const b = Buffer.alloc(165);
        b.writeBigUInt64LE(2n ** 64n - 1n, 64);
        return { data: b, owner: PROGRAM };
      }),
    },
  }),
  useWalletCompat: () => ({ publicKey: OWNER, connected: true, signTransaction: vi.fn() }),
}));
vi.mock("@/hooks/useWalletAtaBalance", () => ({ useWalletAtaBalance: () => ({ balance: h.balance, decimals: 6 }) }));
vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(async (a: (typeof h.sent)[number]) => {
    h.sent.push(a);
    return "SIGDEPOSIT0000000000";
  }),
}));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 9n, matcherSequence: 3n, positionEpoch: 0n })),
}));
// jsdom cross-realm Buffers break PDA/ATA derivation (the other hook suites stub these the same way).
vi.mock("@percolatorct/sdk", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@percolatorct/sdk")),
  getAta: vi.fn(async () => new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1")),
  deriveVaultAuthority: vi.fn(() => [new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), 255]),
}));
vi.mock("@/lib/programAllowlist", () => ({ isKnownProgram: () => true, assertKnownProgram: () => {} }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: MINT, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    wrapperConfigV17: { oracleMode: 0 },
    programId: PROGRAM,
    refresh: h.refresh,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 100_000_000n, priceUsd: 100 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP" } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => ({ flags: { p3: false } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/dev/RenderProfiler", () => ({ RenderProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/trade/OtherMarketPositions", () => ({ OtherMarketPositions: () => null }));
vi.mock("@/components/trade/TradeHistory", () => ({ TradeHistory: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => null }));
vi.mock("@/components/trade/ClosePositionModal", () => ({ ClosePositionModal: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({
  PositionNftMenu: () => null,
  ClosedPositionNftNotice: () => null,
  NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position", wrappedHint: "hint" },
}));

import { PositionsDock } from "@/components/trade/PositionsDock";

beforeEach(() => {
  localStorage.clear();
  h.sent.length = 0;
  h.balance = 100_000_000n;
  h.refresh.mockClear();
  h.account = acct({});
  h.wrapped = null;
});

describe("PositionsDock + Margin (#3304)", () => {
  it("the owned row has a + Margin button, placed before Close", () => {
    render(<PositionsDock slabAddress={SLAB.toBase58()} />);
    const margin = screen.getByTestId("position-add-margin");
    const close = screen.getByTestId("position-close");
    expect(margin).toHaveTextContent("+ Margin");
    expect(margin.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an NFT-wrapped row has no + Margin (a deposit cannot back a position held in escrow)", () => {
    h.account = null;
    h.wrapped = { ...acct({ positionSize: -20_000_000n }), nftMint: OWNER, nftPda: OWNER };
    render(<PositionsDock slabAddress={SLAB.toBase58()} />);
    expect(screen.getByTestId("position-close-wrapped")).toBeInTheDocument();
    expect(screen.queryByTestId("position-add-margin")).toBeNull();
  });

  it("with an owned AND a wrapped row, only the owned row offers + Margin", () => {
    h.wrapped = { ...acct({ positionSize: -20_000_000n }, new PublicKey("SysvarRent111111111111111111111111111111111")), nftMint: OWNER, nftPda: OWNER };
    render(<PositionsDock slabAddress={SLAB.toBase58()} />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(2);
    expect(screen.getAllByTestId("position-add-margin")).toHaveLength(1);
  });

  it("deposits into the account the row shows: the real deposit instruction names the row's account, the amount and the live identity", async () => {
    render(<PositionsDock slabAddress={SLAB.toBase58()} />);
    fireEvent.click(screen.getByTestId("position-add-margin"));
    const dialog = screen.getByRole("dialog", { name: /add margin/i });
    // Labelled in the collateral, not the market's base asset.
    fireEvent.change(within(dialog).getByPlaceholderText("0.00 USDC"), { target: { value: "1.5" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /deposit margin/i })); });

    await waitFor(() => expect(h.sent).toHaveLength(1));
    const ixs = h.sent[0].instructions;
    const dep = ixs[ixs.length - 1];
    expect(dep.keys[0].pubkey.equals(OWNER)).toBe(true);
    expect(dep.keys[1].pubkey.equals(SLAB)).toBe(true);
    expect(dep.keys[2].pubkey.equals(ROW_PK)).toBe(true); // THE ROW'S ACCOUNT
    // v18 wire: [tag u8][portfolioId u64][expectedSequence u64][amount u128].
    const data = Buffer.from(dep.data);
    expect(data[0]).toBe(3);
    expect(data.readBigUInt64LE(1)).toBe(9n);
    expect(data.readBigUInt64LE(9)).toBe(3n);
    expect(data.readBigUInt64LE(17)).toBe(1_500_000n);
    // The slab is refreshed so capital and liquidation risk update.
    expect(h.refresh).toHaveBeenCalled();
  });

  it("the wallet-balance check still blocks an over-balance deposit (inline error, nothing sent)", () => {
    h.balance = 2_000_000n;
    render(<PositionsDock slabAddress={SLAB.toBase58()} />);
    fireEvent.click(screen.getByTestId("position-add-margin"));
    const dialog = screen.getByRole("dialog", { name: /add margin/i });
    fireEvent.change(within(dialog).getByPlaceholderText("0.00 USDC"), { target: { value: "50" } });
    expect(within(dialog).getByTestId("add-margin-amount-error")).toHaveTextContent(/exceeds your wallet balance \(2 USDC available\)/i);
    expect(within(dialog).getByRole("button", { name: /deposit margin/i })).toBeDisabled();
    expect(h.sent).toHaveLength(0);
  });

  it("closing the dialog leaves the row alone", () => {
    render(<PositionsDock slabAddress={SLAB.toBase58()} />);
    fireEvent.click(screen.getByTestId("position-add-margin"));
    fireEvent.click(within(screen.getByRole("dialog", { name: /add margin/i })).getByLabelText("Close"));
    expect(screen.queryByRole("dialog", { name: /add margin/i })).toBeNull();
  });
});
