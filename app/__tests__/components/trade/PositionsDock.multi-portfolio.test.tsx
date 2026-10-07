/**
 * #2560 isolated margin: the positions dock for a wallet with a CROSS and one or more ISOLATED
 * portfolios on a market, rendered for real (only hooks / RPC edges are mocked). Replaces the
 * source-grep test of the first PR.
 *  - one portfolio holding the position keeps today's single row (no Cross/Isolated column);
 *  - 2+ positions (or a lone isolated one) render one row per portfolio with Cross / Isolated badges
 *    that follow the shared selector's order, whatever order the RPC returned;
 *  - Close and +/- Margin act on THAT row's portfolio (reclaim only for isolated);
 *  - an isolated row never shows the cross account's cached entry.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  infos: [] as unknown[],
  primary: null as unknown,
  closePosition: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  refresh: vi.fn(),
}));

const OWNER = new PublicKey(new Uint8Array(32).fill(0x42));
const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const ADL_ONE = 1_000_000_000_000_000n;

vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => h.primary,
  useOwnerMarketPortfolios: () => h.infos,
  useUserAccountScanPending: () => false,
}));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: h.closePosition, loading: false, error: null, prewarmClose: vi.fn(), resetPhase: vi.fn() }),
}));
vi.mock("@/hooks/useDeposit", () => ({ useDeposit: () => ({ deposit: h.deposit, loading: false, error: null }) }));
vi.mock("@/hooks/useWithdraw", () => ({ useWithdraw: () => ({ withdraw: h.withdraw, loading: false, error: null }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: ADL_ONE, aShort: ADL_ONE },
    wrapperConfigV17: {},
    refresh: h.refresh,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 100_000_000n, priceUsd: 100 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP" } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/dev/RenderProfiler", () => ({ RenderProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/trade/OtherMarketPositions", () => ({ OtherMarketPositions: () => null }));
vi.mock("@/components/trade/TradeHistory", () => ({ TradeHistory: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({ PositionNftMenu: () => null, ClosedPositionNftNotice: () => null, NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap" } }));
vi.mock("@/components/share/PnlShareButton", () => ({ PnlShareButton: () => null }));
vi.mock("@/components/trade/ClosePositionModal", () => ({
  ClosePositionModal: (p: { onConfirm: (pct: number) => void }) => <button data-testid="confirm-close" onClick={() => p.onConfirm(100)}>confirm</button>,
}));

import { PositionsDock } from "@/components/trade/PositionsDock";
import { listOwnerPortfolios } from "@/lib/owner-portfolio";
import { generateIsolatedKeypair } from "@/lib/owner-portfolio";
import { saveEntryPrice } from "@/lib/entry-price";

vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  return { ...real, parsePortfolioV17: (d: Uint8Array) => ({ owner: new PublicKey(d.slice(116, 148)) }) };
});

const mk = (pubkey: PublicKey, over: Record<string, unknown> = {}) => ({
  idx: 0,
  pubkey,
  account: {
    kind: 0, owner: OWNER, capital: 100_000_000n, pnl: 0n, positionSize: 1_000_000n,
    entryPrice: 0n, adlABasis: ADL_ONE, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

// a cross key low in the alphabet and an isolated key ground to sort after it
let cross: PublicKey;
let iso: PublicKey;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  do { cross = Keypair.generate().publicKey; } while (cross.toBase58()[0] > "k");
  iso = generateIsolatedKeypair(cross).publicKey;
});

/** The shared selector's order for whatever order the RPC returned (iso FIRST on purpose). */
const listed = (rows: ReturnType<typeof mk>[]) => {
  const data = (pk: PublicKey) => {
    const d = Buffer.alloc(V17_PORTFOLIO_ACCOUNT_LEN);
    OWNER.toBuffer().copy(d, 116);
    return { pubkey: pk, account: { data: d } };
  };
  const order = listOwnerPortfolios(rows.map((r) => data(r.pubkey)), OWNER).map((p) => p.pubkey.toBase58());
  return order.map((k) => rows.find((r) => r.pubkey.toBase58() === k)!);
};
const setPortfolios = (rows: ReturnType<typeof mk>[]) => {
  h.infos = listed(rows);
  h.primary = h.infos[0];
};

describe("single vs multi", () => {
  it("one portfolio holding the position: today's single row, no Cross/Isolated column", () => {
    setPortfolios([mk(cross)]);
    render(<PositionsDock slabAddress={SLAB} />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(1);
    expect(screen.queryByText("Isolated")).toBeNull();
    expect(screen.queryByText("Mode")).toBeNull();
  });

  it("the single row reads the displayed portfolio's OWN scoped entry over the wallet's legacy one", () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 5, OWNER.toBase58()); // legacy
    saveEntryPrice(SLAB, 0, 85_000_000n, 5, OWNER.toBase58(), cross.toBase58()); // this portfolio's own
    setPortfolios([mk(cross)]);
    render(<PositionsDock slabAddress={SLAB} />);
    const row = screen.getByTestId("position-row").textContent ?? "";
    expect(row).toContain("$85.00");
    expect(row).not.toContain("$90.00");
  });

  it("a flat isolated account does not make a phantom row; the cross position keeps the single row", () => {
    setPortfolios([mk(iso, { positionSize: 0n }), mk(cross)]);
    render(<PositionsDock slabAddress={SLAB} />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(1);
    expect(screen.queryByText("Isolated")).toBeNull();
  });
});

describe("cross + isolated: one row per portfolio, badges that never swap", () => {
  it("labels the cross account Cross and the isolated one Isolated even when the RPC returned the isolated one first", () => {
    setPortfolios([mk(iso, { positionSize: -2_000_000n }), mk(cross)]);
    render(<PositionsDock slabAddress={SLAB} />);
    const rows = screen.getAllByTestId("position-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Cross")).toBeInTheDocument();
    expect(within(rows[0]).getByText("LONG")).toBeInTheDocument(); // the cross account's long
    expect(within(rows[1]).getByText("Isolated")).toBeInTheDocument();
    expect(within(rows[1]).getByText("SHORT")).toBeInTheDocument();
  });

  it("a lone isolated position beside a FLAT cross account still renders as Isolated (not as the main row)", () => {
    setPortfolios([mk(cross, { positionSize: 0n }), mk(iso)]);
    render(<PositionsDock slabAddress={SLAB} />);
    const rows = screen.getAllByTestId("position-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Isolated")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Cross")).toBeNull();
  });

  it("an isolated row never shows the cross account's cached entry (unknown), while the cross row does", () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 5, OWNER.toBase58()); // legacy = the cross account's entry
    setPortfolios([mk(iso), mk(cross)]);
    render(<PositionsDock slabAddress={SLAB} />);
    const [crossRow, isoRow] = screen.getAllByTestId("position-row");
    expect(crossRow.textContent).toContain("$90.00");
    expect(isoRow.textContent).not.toContain("$90.00");
  });
});

describe("actions act on THAT row's portfolio", () => {
  beforeEach(() => {
    setPortfolios([mk(iso, { capital: 40_000_000n }), mk(cross)]);
    h.closePosition.mockResolvedValue({ signature: "s" });
  });

  it("± Margin exists only on the isolated row", () => {
    render(<PositionsDock slabAddress={SLAB} />);
    const [crossRow, isoRow] = screen.getAllByTestId("position-row");
    expect(within(crossRow).queryByTestId("adjust-margin")).toBeNull();
    expect(within(isoRow).getByTestId("adjust-margin")).toBeInTheDocument();
  });

  it("Close on the isolated row targets the isolated portfolio and asks for the rent reclaim", async () => {
    render(<PositionsDock slabAddress={SLAB} />);
    const isoRow = screen.getAllByTestId("position-row")[1];
    fireEvent.click(within(isoRow).getByTestId("position-close"));
    await act(async () => fireEvent.click(screen.getByTestId("confirm-close")));
    expect(h.closePosition).toHaveBeenCalledTimes(1);
    const [pct, opts] = h.closePosition.mock.calls[0];
    expect(pct).toBe(100);
    expect((opts.portfolioPk as PublicKey).equals(iso)).toBe(true);
    expect(opts.reclaimOnClose).toBe(true);
  });

  it("Close on the CROSS row targets the cross portfolio and NEVER reclaims it", async () => {
    render(<PositionsDock slabAddress={SLAB} />);
    const crossRow = screen.getAllByTestId("position-row")[0];
    fireEvent.click(within(crossRow).getByTestId("position-close"));
    await act(async () => fireEvent.click(screen.getByTestId("confirm-close")));
    const [, opts] = h.closePosition.mock.calls[0];
    expect((opts.portfolioPk as PublicKey).equals(cross)).toBe(true);
    expect(opts.reclaimOnClose).toBe(false);
  });

  it("± Margin: Add deposits into the isolated portfolio, Remove withdraws from it (never the cross account)", async () => {
    h.deposit.mockResolvedValue("d");
    h.withdraw.mockResolvedValue("w");
    render(<PositionsDock slabAddress={SLAB} />);
    const isoRow = screen.getAllByTestId("position-row")[1];
    fireEvent.click(within(isoRow).getByTestId("adjust-margin"));
    fireEvent.change(screen.getByTestId("margin-amount"), { target: { value: "5" } });
    await act(async () => fireEvent.click(screen.getByTestId("margin-submit")));
    expect(h.deposit).toHaveBeenCalledTimes(1);
    const dep = h.deposit.mock.calls[0][0];
    expect(dep.amount).toBe(5_000_000n);
    expect(dep.accountExists).toBe(true);
    expect((dep.portfolioPk as PublicKey).equals(iso)).toBe(true);
    expect(h.withdraw).not.toHaveBeenCalled();

    // reopen and remove
    fireEvent.click(within(screen.getAllByTestId("position-row")[1]).getByTestId("adjust-margin"));
    fireEvent.click(screen.getByTestId("margin-remove"));
    fireEvent.change(screen.getByTestId("margin-amount"), { target: { value: "3" } });
    await act(async () => fireEvent.click(screen.getByTestId("margin-submit")));
    expect(h.withdraw).toHaveBeenCalledTimes(1);
    const wd = h.withdraw.mock.calls[0][0];
    expect(wd.amount).toBe(3_000_000n);
    expect((wd.portfolioPk as PublicKey).equals(iso)).toBe(true);
  });

  it("Remove cannot exceed the isolated portfolio's own margin", () => {
    render(<PositionsDock slabAddress={SLAB} />);
    fireEvent.click(within(screen.getAllByTestId("position-row")[1]).getByTestId("adjust-margin"));
    fireEvent.click(screen.getByTestId("margin-remove"));
    fireEvent.change(screen.getByTestId("margin-amount"), { target: { value: "41" } }); // it holds 40
    expect((screen.getByTestId("margin-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(h.withdraw).not.toHaveBeenCalled();
  });
});
