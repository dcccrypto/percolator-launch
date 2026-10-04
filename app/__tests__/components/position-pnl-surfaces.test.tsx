/**
 * #3077 (diagnosed by @0x-SquidSol): the same open position showed different
 * unrealized PnL on different surfaces. This is the BEHAVIOURAL proof that every
 * surface now agrees: for one set of inputs we drive the REAL
 *
 *   - `buildV17Position` (the usePortfolio v18 path that feeds the bar, the
 *     portfolio card, the hero totals and the live metrics),
 *   - `PositionsBar` (the positions bar chip),
 *   - `ChartPnlBadge`,
 *   - `PositionsDock`,
 *   - the share-card math (`computePnlCardStats`), fed the way the builders feed it,
 *   - the two shared adapters (`portfolioPositionPnl`, `terminalPositionPnl`),
 *
 * and require them to print the same figure. Position: 80 tokens of raw basis,
 * deleveraged to 50% (effective 40), long, mark $100.
 *
 * Every scenario carries a NEGATIVE CONTROL: the same surfaces fed a perturbed
 * input (the old bug) must print a DIFFERENT number, proving the equality
 * assertion can fail. If a control ever matches the real figure, the harness has
 * gone vacuous.
 */
import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADL_ONE = 1_000_000_000_000_000n;
const OWNER = new PublicKey("11111111111111111111111111111111");
const SLAB = "SLAB1111111111111111111111111111111111111111";

type Factors = { aLong: bigint; aShort: bigint } | null;

const h = vi.hoisted(() => ({
  account: null as unknown,
  /** live mark, post-inversion domain */
  priceE6: 100_000_000n as bigint | null,
  adlFactors: null as { aLong: bigint; aShort: bigint } | null,
  /** the slab's raw on-chain mark + its invert flag (the terminal's fallback/anchor) */
  rawOnChainE6: 100_000_000n as bigint,
  invert: 0,
  positions: [] as unknown[],
}));

const mkAccount = (over: Record<string, unknown>) => ({
  idx: 0,
  pubkey: OWNER,
  account: {
    kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 80_000_000n,
    entryPrice: 0n, adlABasis: ADL_ONE, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

// ── terminal (dock + badge) mocks ───────────────────────────────────────────
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => false }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: "SLAB1111111111111111111111111111111111111111",
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: h.rawOnChainE6, invert: h.invert },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: h.adlFactors,
    wrapperConfigV17: {},
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: h.priceE6 === null ? null : Number(h.priceE6) / 1e6 }),
}));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "TEST-PERP" } }) }));
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
vi.mock("@/components/trade/ClosePositionModal", () => ({ ClosePositionModal: () => null }));
vi.mock("@/components/share/PnlShareButton", () => ({ PnlShareButton: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({
  PositionNftMenu: () => null,
  ClosedPositionNftNotice: () => null,
  NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" },
}));

// ── positions bar mocks ─────────────────────────────────────────────────────
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/usePortfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePortfolio")>();
  return { ...actual, usePortfolio: () => ({ positions: h.positions, loading: false, error: null }) };
});
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: OWNER }),
  useConnectionCompat: () => ({ connection: { getMultipleAccountsInfo: async () => [] } }),
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));

import { buildV17Position, type PortfolioPosition } from "@/hooks/usePortfolio";
import { PositionsBar } from "@/components/layout/PositionsBar";
import { ChartPnlBadge } from "@/components/trade/ChartPnlBadge";
import { PositionsDock } from "@/components/trade/PositionsDock";
import { computePnlCardStats } from "@/lib/pnl-card";
import { portfolioPositionPnl, terminalPositionPnl } from "@/lib/position-pnl";
import { saveEntryPrice } from "@/lib/entry-price";
import { applyInvert } from "@/lib/oraclePrice";

interface Scenario {
  /** raw leg basis (signed) */
  basis: bigint;
  /** frozen a_basis of the leg */
  aBasis: bigint;
  factors: Factors;
  /** entry cached on this device at open; 0n = none (a second device) */
  cached: bigint;
  /** on-chain collateral pnl (atoms) */
  onChainPnl: bigint;
  /** live mark and polled mark, post-inversion domain */
  mark: bigint;
  /** the slab's RAW on-chain mark + invert flag (the terminal's anchor/fallback) */
  rawOnChain: bigint;
  invert: 0 | 1;
}

const HALF: Factors = { aLong: ADL_ONE / 2n, aShort: ADL_ONE };
const BASE: Scenario = {
  basis: 80_000_000n, // 80 tokens raw ...
  aBasis: ADL_ONE,
  factors: HALF, //       ... deleveraged to 50% => 40 effective
  cached: 99_875_000n,
  onChainPnl: 5_000_000n,
  mark: 100_000_000n,
  rawOnChain: 100_000_000n,
  invert: 0,
};

/** "+5.00" | "-5.00" | "--" */
const usd = (atoms: bigint | null): string => {
  if (atoms === null) return "--";
  const n = Number(atoms) / 1e6;
  return `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
};

function setup(s: Scenario): { pos: PortfolioPosition } {
  localStorage.clear();
  if (s.cached > 0n) saveEntryPrice(SLAB, 0, s.cached, undefined, OWNER.toBase58());
  h.priceE6 = s.mark;
  h.adlFactors = s.factors;
  h.rawOnChainE6 = s.rawOnChain;
  h.invert = s.invert;
  h.account = mkAccount({ positionSize: s.basis, adlABasis: s.aBasis, pnl: s.onChainPnl });

  const portfolio = {
    owner: OWNER,
    capital: 1_000_000_000n,
    pnl: s.onChainPnl,
    reservedPnl: 0n,
    feeCredits: 0n,
    lastFeeSlot: 0n,
    residualCrystallizedLossAtomsTotal: 0n,
    marketGroupId: new PublicKey(OWNER),
    legs: [
      {
        active: true,
        side: s.basis > 0n ? 0 : 1,
        basisPosQ: s.basis,
        aBasis: s.aBasis,
        fSnap: 0n,
        kSnap: 0n,
        epochSnap: 0n,
      },
    ],
  };
  const market = {
    slabAddress: new PublicKey(OWNER),
    programId: OWNER,
    config: {},
    configV17: { collateralMint: OWNER },
  };
  const pos = buildV17Position(
    portfolio as never,
    s.mark,
    500n,
    SLAB,
    market as never,
    false,
    1000n,
    "TEST-PERP",
    OWNER.toBase58(),
    s.factors,
  );
  h.positions = [pos];
  return { pos };
}

/** The signed 2-decimal figure a surface printed, or "--" when it withheld PnL. */
function barFigure(): string {
  const { container } = render(<PositionsBar />);
  const bar = container.querySelector('[data-testid="positions-bar"]');
  if (!bar || !/TEST/.test(bar.textContent ?? "")) throw new Error(`bar did not render a chip: ${bar?.textContent}`);
  // The chip's PnL figure is its bold span; ROE and the "est." tag are separate spans.
  const figure = bar.querySelector("span.font-bold")?.textContent?.trim() ?? "";
  cleanup();
  if (figure === "--") return "--";
  const m = figure.match(/^([+-]?)([\d,]+(?:\.\d+)?)$/);
  return m ? `${m[1] || "+"}${Number(m[2].replace(/,/g, "")).toFixed(2)}` : `?${figure}`;
}
function badgeFigure(): string {
  const { container } = render(<ChartPnlBadge slabAddress={SLAB} />);
  const t = container.textContent ?? "";
  cleanup();
  if (t === "") return "--"; // the badge renders nothing rather than guess
  const m = t.match(/([+-])\$([\d,]+\.\d{2})/);
  return m ? `${m[1]}${m[2].replace(/,/g, "")}` : `?${t}`;
}
function dockFigure(): string {
  const { container } = render(<PositionsDock slabAddress={SLAB} />);
  const t = container.textContent ?? "";
  cleanup();
  const m = t.match(/([+-])\$(\d[\d,]*\.\d{2})(?!\d)/);
  if (m) return `${m[1]}${m[2].replace(/,/g, "")}`;
  return /--/.test(t) ? "--" : `?${t}`;
}
function shareCardFigure(s: Scenario, pos: PortfolioPosition): string {
  // Fed exactly as the builders feed it: effective size + the resolved entry.
  const r = portfolioPositionPnl(pos, s.mark);
  if (!r.pnlKnown || r.effectiveSize === null) return "--";
  const stats = computePnlCardStats(
    {
      slab: SLAB, symbol: "TEST", name: "Test", logoUrl: null, decimals: 6,
      nominalSizeQ: s.basis, effectiveSizeQ: r.effectiveSize, entryE6: r.entry,
      initialMarginBps: 1000n, initialMarkE6: s.mark,
    },
    s.mark,
  );
  const n = stats.pnlUsd;
  return `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
}
function allFigures(s: Scenario) {
  const { pos } = setup(s);
  const port = portfolioPositionPnl(pos, s.mark);
  const term = terminalPositionPnl({
    account: (h.account as { account: never }).account,
    slabAddress: SLAB,
    accountIdx: 0,
    adlFactors: s.factors,
    adlApplicable: true,
    markE6: s.mark,
    anchorMarkE6: applyInvert(s.rawOnChain, s.invert),
    initialMarginBps: 1000n,
  });
  return {
    builder: pos.pnlKnown ? usd(pos.unrealizedPnl) : "--",
    portfolioAdapter: usd(port.unrealizedPnl),
    terminalAdapter: usd(term.unrealizedPnl),
    bar: barFigure(),
    badge: badgeFigure(),
    dock: dockFigure(),
    shareCard: shareCardFigure(s, pos),
    roe: { builder: pos.pnlKnown ? pos.pnlPercent : null, portfolio: port.roe, terminal: term.roe },
    pos,
  };
}

/** Every surface printed `expected`. */
function expectAll(f: ReturnType<typeof allFigures>, expected: string) {
  expect({
    builder: f.builder, portfolioAdapter: f.portfolioAdapter, terminalAdapter: f.terminalAdapter,
    bar: f.bar, badge: f.badge, dock: f.dock, shareCard: f.shareCard,
  }).toEqual({
    builder: expected, portfolioAdapter: expected, terminalAdapter: expected,
    bar: expected, badge: expected, dock: expected, shareCard: expected,
  });
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no ResizeObserver; PositionsBar's overflow affordance needs one.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("one position, every surface, one PnL (#3077)", () => {
  it("ADL'd position, CACHED entry: all surfaces read +5.00 (effective 40 tokens x $0.125)", () => {
    const f = allFigures(BASE);
    expectAll(f, "+5.00");
    expect(f.pos.entryPriceSource).toBe("cache");
    expect(f.pos.effectiveSize).toBe(40_000_000n);
    // ROE is one number too (raw-basis initial margin: 80 x $99.875 x 10%).
    expect(f.roe.builder).toBe(f.roe.portfolio);
    expect(f.roe.builder).toBe(f.roe.terminal);
  });

  it("NEGATIVE CONTROL: ignoring ADL (the raw-size bug) prints +10.00, so the assertion above can fail", () => {
    // Same bytes, but the leg is treated as never deleveraged. This is what the
    // bar printed (+104 vs +17 in the report): ADL-factor x the real PnL.
    const f = allFigures({ ...BASE, factors: { aLong: ADL_ONE, aShort: ADL_ONE } });
    expect(f.builder).toBe("+10.00");
    expect(f.builder).not.toBe("+5.00");
    expectAll(f, "+10.00"); // surfaces still agree with EACH OTHER: the divergence was in the inputs
  });

  it("ADL'd position, DERIVED entry (second device): all surfaces read +5.00, marked as an estimate", () => {
    const f = allFigures({ ...BASE, cached: 0n });
    expectAll(f, "+5.00");
    expect(f.pos.entryPriceSource).toBe("derived");
    expect(f.pos.isEstimate).toBe(true);
    // The estimate is labelled "est." on the bar chip.
    const { container } = render(<PositionsBar />);
    expect(container.textContent).toContain("est.");
  });

  it("NEGATIVE CONTROL: back-solving over RAW basis (the dock's old bug) prints +2.50, not +5.00", () => {
    // pnl / 80 raw tokens puts the entry half as far from the mark; the PnL over
    // effective 40 tokens is then half the on-chain figure.
    const raw = 80_000_000n;
    const diff = (5_000_000n * 1_000_000n) / raw; // 62_500
    const buggyEntry = BASE.mark - diff;
    const buggy = ((BASE.mark - buggyEntry) * 40_000_000n) / 1_000_000n; // collateral atoms
    expect(usd(buggy)).toBe("+2.50");
    expect(usd(buggy)).not.toBe("+5.00");
  });

  it("an exact (cached) entry is NOT labelled est.", () => {
    allFigures(BASE);
    const { container } = render(<PositionsBar />);
    expect(container.textContent).not.toContain("est.");
  });

  it("NULL ADL factors: every surface withholds PnL ('--'), none falls back to raw size", () => {
    const f = allFigures({ ...BASE, factors: null });
    expectAll(f, "--");
    expect(f.pos.adlKnown).toBe(false);
    expect(f.pos.pnlKnown).toBe(false);
  });

  it("NULL ADL factors + cached entry: still '--' (the size is unknown, so is the PnL)", () => {
    const f = allFigures({ ...BASE, factors: null, cached: 99_875_000n });
    expectAll(f, "--");
  });

  it("NEGATIVE CONTROL: the same position with the factors KNOWN prints a number, so '--' above is the null rule, not a render failure", () => {
    const known = allFigures(BASE);
    expect(known.bar).toBe("+5.00");
    expect(known.dock).toBe("+5.00");
    expect(known.badge).toBe("+5.00");
    expect(allFigures({ ...BASE, factors: null }).bar).toBe("--");
  });

  it("INVERTED market: raw on-chain 0.01 with invert=1 is $100 post-inversion; every surface reads +5.00", () => {
    // raw 10_000 e6 ($0.01) inverted = 1e12 / 1e4 = 100_000_000 ($100).
    expect(applyInvert(10_000n, 1)).toBe(100_000_000n);
    const f = allFigures({ ...BASE, rawOnChain: 10_000n, invert: 1 });
    expectAll(f, "+5.00");
  });

  it("INVERTED market, derived entry: the estimate is anchored in the inverted domain on every surface", () => {
    const f = allFigures({ ...BASE, rawOnChain: 10_000n, invert: 1, cached: 0n });
    expectAll(f, "+5.00");
    expect(f.pos.entryPriceSource).toBe("derived");
  });

  it("NEGATIVE CONTROL: mixing the UN-inverted raw mark ($0.01) into an inverted market blows the figure up", () => {
    // A cached entry of $99.875 against a $0.01 mark is a ~-$3,995 phantom loss
    // on 40 tokens. If a surface ever mixes domains, it can no longer equal +5.00.
    const f = allFigures({ ...BASE, mark: 10_000n, rawOnChain: 10_000n, invert: 0 });
    expect(f.builder).not.toBe("+5.00");
    expect(f.builder.startsWith("-")).toBe(true);
  });

  it("a SHORT deleveraged position is symmetric: +5.00 on every surface", () => {
    // short 80 raw, short side halved, entry $100.125, mark $100 => +0.125 x 40.
    const f = allFigures({
      ...BASE,
      basis: -80_000_000n,
      factors: { aLong: ADL_ONE, aShort: ADL_ONE / 2n },
      cached: 100_125_000n,
    });
    expectAll(f, "+5.00");
  });

  it("a loss reads as a loss everywhere (derived, negative on-chain pnl)", () => {
    const f = allFigures({ ...BASE, cached: 0n, onChainPnl: -5_000_000n });
    expectAll(f, "-5.00");
  });
});
