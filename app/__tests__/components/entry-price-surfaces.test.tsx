/**
 * #2660 — every surface shows the RESOLVED entry (cache | derived), and never
 * the mark placeholder the "unknown" path carries, nor a PnL computed from it.
 *
 * Positions are built by the REAL `buildV17Position` from REAL devnet v18
 * portfolio bytes (wrapper GnwdeQr…, captured 2026-09-29):
 *   2SewEcvf… short leg, on-chain pnl ≠ 0  → entry "derived" from pnl
 *   DAC2a44p… long leg,  on-chain pnl = 0  → entry "unknown" (unless cached)
 * Neither account stores an entry — `account.entryPrice` is structurally 0n on
 * v17/v18 (engine PortfolioLegV16 has basis/a_basis/k_snap/f_snap, no entry).
 */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";

const state = vi.hoisted(() => ({ positions: [] as unknown[] }));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/dynamic", () => ({ default: () => () => <button>ConnectButton</button> }));
vi.mock("@/hooks/usePortfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePortfolio")>();
  return {
    ...actual,
    usePortfolio: () => ({
      positions: state.positions,
      totalPnl: 0n,
      totalDeposited: 0n,
      totalValue: 0n,
      totalUnrealizedPnl: 0n,
      atRiskCount: 0,
      loading: false,
      isRefreshing: false,
      refresh: () => {},
    }),
  };
});
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: new PublicKey("11111111111111111111111111111111") }),
}));
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({ positions: [], totalRedeemable: 0, loading: false, isRefreshing: false, error: null, refresh: () => {} }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => null }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: () => {} }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => null }));
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => ({ statsMap: new Map() }) }));
vi.mock("@/hooks/useLiveSlabPrices", () => ({ useLiveSlabPrices: () => new Map() }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock("@/components/ui/ShimmerSkeleton", () => ({ ShimmerSkeleton: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false, getMockPortfolioPositions: () => [] }));

import { buildV17Position, type PortfolioPosition } from "@/hooks/usePortfolio";
import { PositionSummary } from "@/components/dashboard/PositionSummary";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { ClosePositionModal } from "@/components/trade/ClosePositionModal";
import { saveEntryPrice } from "@/lib/entry-price";
import { estimateEntryFromPnl } from "@/lib/trading";
import { describeEntryPrice, displayEntryE6 } from "@/lib/entry-price-display";

function loadPortfolio(name: string) {
  const f = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../fixtures/${name}.portfolio.json`), "utf8")) as {
    market: string;
    dataBase64: string;
  };
  return { market: f.market, portfolio: parsePortfolioV17(Buffer.from(f.dataBase64, "base64")) };
}

const MARK = 1_000_000n; // $1.000000 — any positive mark exercises the paths
const WALLET = "11111111111111111111111111111111";

function build(name: string): PortfolioPosition {
  const { market, portfolio } = loadPortfolio(name);
  const discovered = {
    slabAddress: new PublicKey(market),
    programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
    config: {},
    configV17: { collateralMint: new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC") },
  } as never;
  return buildV17Position(portfolio, MARK, 500n, market, discovered, false, 1000n, "TEST-PERP", WALLET, { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n });
}

const MARK_TEXT = "$1.000000";

beforeEach(() => {
  localStorage.clear();
  state.positions = [];
});

describe("real v18 portfolio bytes → resolved entry", () => {
  it("no entry is stored on-chain: account.entryPrice is 0n on both", () => {
    expect(build("2SewEcvf").account.entryPrice).toBe(0n);
    expect(build("DAC2a44p").account.entryPrice).toBe(0n);
  });

  it("pnl ≠ 0 → derived entry, back-solved from the on-chain pnl (not the mark)", () => {
    const pos = build("2SewEcvf");
    const { portfolio } = loadPortfolio("2SewEcvf");
    expect(portfolio.pnl).not.toBe(0n);
    expect(pos.entryPriceSource).toBe("derived");
    expect(pos.effectiveEntryPrice).toBe(estimateEntryFromPnl(pos.effectiveSize, portfolio.pnl, MARK));
    expect(pos.effectiveEntryPrice).not.toBe(MARK);
  });

  it("pnl = 0, nothing cached → unknown, and the carried value IS the mark", () => {
    const pos = build("DAC2a44p");
    expect(pos.entryPriceSource).toBe("unknown");
    expect(pos.effectiveEntryPrice).toBe(MARK);
    expect(displayEntryE6(pos.effectiveEntryPrice, pos.entryPriceSource)).toBe(0n);
  });

  it("pnl = 0 but cached at open → cache", () => {
    const { market } = loadPortfolio("DAC2a44p");
    saveEntryPrice(market, 0, 1_234_567n, undefined, WALLET);
    const pos = build("DAC2a44p");
    expect(pos.entryPriceSource).toBe("cache");
    expect(pos.effectiveEntryPrice).toBe(1_234_567n);
  });
});

const summaryCell = (label: string) => screen.getByText(label).parentElement as HTMLElement;

describe("dashboard Overview (PositionSummary) — Defect 1", () => {
  it("renders the DERIVED entry instead of a dash", () => {
    const pos = build("2SewEcvf");
    state.positions = [pos];
    render(<PositionSummary />);
    const cell = summaryCell("Entry:");
    expect(cell.textContent).toContain(describeEntryPrice({ entryE6: pos.effectiveEntryPrice, source: "derived" }).text);
    expect(cell.textContent).not.toContain("—");
  });

  it("renders the CACHED entry", () => {
    const { market } = loadPortfolio("DAC2a44p");
    saveEntryPrice(market, 0, 1_234_567n, undefined, WALLET);
    state.positions = [build("DAC2a44p")];
    render(<PositionSummary />);
    expect(summaryCell("Entry:").textContent).toContain("$1.234567");
  });

  it("unknown → dash for Entry, and '--' (not a $0.00 placeholder) for PnL", () => {
    state.positions = [build("DAC2a44p")];
    render(<PositionSummary />);
    expect(summaryCell("Entry:").textContent).toContain("—");
    expect(summaryCell("Entry:").textContent).not.toContain(MARK_TEXT);
    expect(screen.getByText("--")).toBeInTheDocument();
    expect(screen.queryByText(/0\.00%/)).toBeNull();
    // control: the row rendered and the mark is shown in ITS cell
    expect(summaryCell("Mark:").textContent).toContain(MARK_TEXT);
  });
});

function portfolioCell(label: string): HTMLElement {
  const heading = screen.getAllByText(label).find((el) => el.tagName === "P");
  if (!heading) throw new Error(`no ${label} cell`);
  return heading.parentElement as HTMLElement;
}

describe("portfolio list (PortfolioPositionsView) — Defect 2", () => {
  it("unknown → Entry is a dash, NOT the mark; PnL is '--'", () => {
    state.positions = [build("DAC2a44p")];
    render(<PortfolioPositionsView />);
    const entry = portfolioCell("Entry");
    expect(entry.textContent).not.toContain(MARK_TEXT);
    expect(entry.textContent).toContain("—");
    expect(portfolioCell("Mark Price").textContent).toContain(MARK_TEXT); // control
    expect(screen.getByTestId("pnl-unknown")).toBeInTheDocument();
  });

  it("derived → Entry shows the derived value, PnL renders a number", () => {
    const pos = build("2SewEcvf");
    state.positions = [pos];
    render(<PortfolioPositionsView />);
    const expected = describeEntryPrice({ entryE6: pos.effectiveEntryPrice, source: "derived" });
    expect(portfolioCell("Entry").textContent).toContain(expected.text);
    expect(within(portfolioCell("Entry")).getByTitle(expected.title as string)).toBeInTheDocument();
    expect(screen.queryByTestId("pnl-unknown")).toBeNull();
  });
});

describe("ClosePositionModal — unknown entry (callers pass 0n)", () => {
  const props = {
    positionSize: 22_736_956n,
    currentPrice: MARK,
    capital: 494_577_996n,
    symbol: "TEST",
    decimals: 6,
    priceUsd: 1,
    isLong: true,
    loading: false,
    onConfirm: () => {},
    onCancel: () => {},
  };

  it("shows '--' PnL and 'unknown entry' instead of a confident 0 at the mark", () => {
    render(<ClosePositionModal {...props} entryPrice={0n} />);
    expect(screen.getByTestId("close-pnl-unknown")).toHaveTextContent("--");
    expect(screen.getByText("unknown entry")).toBeInTheDocument();
    expect(screen.getByText("excl. PnL")).toBeInTheDocument();
  });

  it("known entry still previews PnL", () => {
    render(<ClosePositionModal {...props} entryPrice={900_000n} />);
    expect(screen.queryByTestId("close-pnl-unknown")).toBeNull();
    expect(screen.getByText("$0.900000")).toBeInTheDocument();
  });
});

describe("trade-terminal surfaces feed describeLiqPrice the entry SOURCE, not `entry > 0n`", () => {
  // On "unknown" the resolved entry is the mark, so `entry > 0n` is always true
  // and let an unknown entry read as "covered — N% mgn" (a safety claim).
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, `../../components/trade/${f}`), "utf8");
  it.each(["PositionsDock.tsx", "PositionPanel.tsx", "OtherMarketPositions.tsx"])("%s", (f) => {
    const src = read(f);
    expect(src).toMatch(/hasResolvedEntry: pnlIsKnown,/);
    expect(src).not.toMatch(/hasResolvedEntry: (entryPriceE6|entryE6) > 0n/);
  });
  it("OrderTicket tracks the existing entry's source", () => {
    const src = read("OrderTicket.tsx");
    expect(src).toMatch(/hasResolvedEntry: existingEntryKnown,/);
    expect(src).toMatch(/entryPriceE6=\{existingEntryKnown \? existingEntryPriceE6 : 0n\}/);
  });
});

describe("hero / aggregate totals never silently sum an unknown PnL as 0 (#3077 item 2)", () => {
  it("every open position unknown: the hero PnL is '--' with a calm caveat", () => {
    state.positions = [build("DAC2a44p")];
    render(<PortfolioPositionsView />);
    const hero = screen.getByTestId("hero-pnl-unknown");
    expect(hero.textContent).toContain("--");
    expect(hero.textContent).toMatch(/Excludes 1 position/);
  });

  it("one known + one unknown: the number stays, and the caveat says one position is excluded", () => {
    state.positions = [build("2SewEcvf"), build("DAC2a44p")];
    render(<PortfolioPositionsView />);
    expect(screen.queryByTestId("hero-pnl-unknown")).toBeNull();
    expect(screen.getByTestId("hero-pnl-caveat").textContent).toMatch(/Excludes 1 position /);
  });

  it("CONTROL: every position known -> neither '--' nor a caveat", () => {
    state.positions = [build("2SewEcvf")];
    render(<PortfolioPositionsView />);
    expect(screen.queryByTestId("hero-pnl-unknown")).toBeNull();
    expect(screen.queryByTestId("hero-pnl-caveat")).toBeNull();
  });
});
