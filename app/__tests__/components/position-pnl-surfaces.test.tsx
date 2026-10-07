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
  /** v17/v18 slab (has a wrapper config) vs legacy v12 */
  wrapperV17: true,
  positions: [] as unknown[],
  modalProps: null as Record<string, unknown> | null,
}));

const mkAccount = (over: Record<string, unknown>) => ({
  idx: 0,
  pubkey: OWNER,
  account: {
    kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 80_000_000n,
    entryPrice: 0n, adlABasis: ADL_ONE, adlEpochSnap: 0n, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

// ── terminal (dock + badge) mocks ───────────────────────────────────────────
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => h.account,
  // #2560: the dock lists every owned portfolio; a single-portfolio wallet is [its account].
  useOwnerMarketPortfolios: () => (h.account ? [h.account] : []),
  useUserAccountScanPending: () => false,
}));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn(), resetPhase: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: "SLAB1111111111111111111111111111111111111111",
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: h.rawOnChainE6, invert: h.invert },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: h.adlFactors,
    wrapperConfigV17: h.wrapperV17 ? {} : null,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: h.priceE6 === null ? null : Number(h.priceE6) / 1e6 }),
}));
vi.mock("@/hooks/useMarketConfig", () => ({
  useMarketConfig: () => ({ lastEffectivePriceE6: h.rawOnChainE6, invert: h.invert }),
}));
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
vi.mock("@/components/trade/ClosePositionModal", () => ({
  ClosePositionModal: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return null;
  },
}));
vi.mock("@/components/share/PnlShareButton", () => ({ PnlShareButton: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({
  PositionNftMenu: () => null,
  ClosedPositionNftNotice: () => null,
  NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" },
}));

// ── positions bar mocks ─────────────────────────────────────────────────────
vi.mock("next/link", () => ({
  default: ({ children, href, title, className, style }: { children: React.ReactNode; href: string; title?: string; className?: string; style?: React.CSSProperties }) => <a href={href} title={title} className={className} style={style}>{children}</a>,
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
import { onChainMarkE6, portfolioPositionPnl, terminalPositionPnl, valueAtMark } from "@/lib/position-pnl";
import { computeEngineLiqPrice } from "@/lib/liquidation-risk";
import { parseAssetAdlFactors } from "@/lib/v17-adl";
import { computeMarginCushion } from "@/lib/liquidation-risk";
import { liveMarginCushion } from "@/hooks/usePortfolio";
import { V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN, V17_MARKET_ASSET_SLOT_LEN, V17_ASSET_SLOT_WRAPPER_LEN } from "@percolatorct/sdk";
import { fireEvent } from "@testing-library/react";
import { formatUsdPriceE6 } from "@/lib/format";
import { saveEntryPrice } from "@/lib/entry-price";

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
  /** the leg's epoch_snap (default 0) */
  epochSnap?: bigint;
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
  h.wrapperV17 = true;
  h.modalProps = null;
  h.account = mkAccount({ positionSize: s.basis, adlABasis: s.aBasis, adlEpochSnap: s.epochSnap ?? 0n, pnl: s.onChainPnl });

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
        epochSnap: s.epochSnap ?? 0n,
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
    anchorMarkE6: onChainMarkE6({ lastEffectivePriceE6: s.rawOnChain, invert: s.invert }, true) ?? undefined,
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
    // ... and it is the engine's ROE: +$5.00 on 40 EFFECTIVE tokens x $99.875 x 10% = $399.50 margin.
    expect(f.roe.builder).toBeCloseTo(1.25, 1);
    // NEGATIVE CONTROL: the raw-basis denominator (80 tokens) would read 0.63%.
    expect(f.roe.builder).not.toBeCloseTo(0.63, 1);
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

  it("INVERTED v17 market (invert=1): markEwmaE6 is ALREADY post-inversion, so it is not inverted again", () => {
    // The wrapper applies `invert` while composing the price (v16_program.rs:6440-6445);
    // the stored on-chain mark is $100 and every surface must read it as $100.
    const f = allFigures({ ...BASE, rawOnChain: 100_000_000n, invert: 1 });
    expectAll(f, "+5.00");
  });

  it("INVERTED v17 market, derived entry: the estimate is anchored on the un-reinverted mark on every surface", () => {
    const f = allFigures({ ...BASE, rawOnChain: 100_000_000n, invert: 1, cached: 0n });
    expectAll(f, "+5.00");
    expect(f.pos.entryPriceSource).toBe("derived");
  });

  it("INVERTED v17 market with NO live price: the dock's on-chain fallback mark is $100, not the $0.01 reciprocal", () => {
    allFigures({ ...BASE, rawOnChain: 100_000_000n, invert: 1 });
    h.priceE6 = null; // WS dropped: the on-chain fallback is what the mark cell shows
    const { container } = render(<PositionsDock slabAddress={SLAB} />);
    expect(container.textContent).toContain(formatUsdPriceE6(100_000_000n));
    expect(container.textContent).not.toContain(formatUsdPriceE6(10_000n));
  });

  it("NEGATIVE CONTROL: a legacy v12 slab DOES apply the flag to its raw price (raw $0.01, invert=1 -> $100)", () => {
    allFigures({ ...BASE, rawOnChain: 10_000n, invert: 1 });
    h.wrapperV17 = false;
    h.priceE6 = null;
    const { container } = render(<PositionsDock slabAddress={SLAB} />);
    expect(container.textContent).toContain(formatUsdPriceE6(100_000_000n));
    // ... and treating that same raw value as a v17 mark shows the unflipped $0.01.
    cleanup();
    h.wrapperV17 = true;
    const v17 = render(<PositionsDock slabAddress={SLAB} />);
    expect(v17.container.textContent).toContain(formatUsdPriceE6(10_000n));
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

// ── #3077 follow-ups ────────────────────────────────────────────────────────

const SLOTS_BASE = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_ASSET_SLOT_WRAPPER_LEN;
/** A real v17 slab byte layout (parsed by the real parser), not a hand-built factors object. */
function slabFactors(aLong: bigint, aShort: bigint, epochLong = 0n, modeLong = 0): Factors {
  const buf = new Uint8Array(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_MARKET_ASSET_SLOT_LEN);
  const dv = new DataView(buf.buffer);
  const u128 = (off: number, v: bigint) => {
    dv.setBigUint64(SLOTS_BASE + off, v & 0xffffffffffffffffn, true);
    dv.setBigUint64(SLOTS_BASE + off + 8, v >> 64n, true);
  };
  u128(49, aLong);
  u128(65, aShort);
  dv.setBigUint64(SLOTS_BASE + 497, epochLong, true);
  buf[SLOTS_BASE + 513] = modeLong;
  return parseAssetAdlFactors(buf, 0);
}

describe("a_side below MIN_A_SIDE, end to end (the M5 control at surface level)", () => {
  it("a long whose a_long drained to 5% (< MIN_A_SIDE = 10%) still reads +0.50 on every surface", () => {
    const factors = slabFactors(ADL_ONE / 20n, ADL_ONE);
    expect(factors).not.toBeNull(); // the old [MIN_A_SIDE, ADL_ONE] guard made this null
    const f = allFigures({ ...BASE, factors });
    // 80 raw x 5% = 4 effective tokens x $0.125
    expectAll(f, "+0.50");
    expect(f.pos.effectiveSize).toBe(4_000_000n);
    expect(f.pos.adlKnown).toBe(true);
  });

  it("BOTH sides drained below MIN_A_SIDE: the long still reads its own side (+0.20)", () => {
    const factors = slabFactors(ADL_ONE / 50n, ADL_ONE / 20n);
    expect(factors).not.toBeNull();
    // 80 raw x 2% = 1.6 tokens x $0.125
    expectAll(allFigures({ ...BASE, factors }), "+0.20");
  });

  it("NEGATIVE CONTROL: if the slot were unreadable (null), the same position shows '--', not a raw-size number", () => {
    expectAll(allFigures({ ...BASE, factors: null }), "--");
  });
});

describe("invalid and reset legs are unknown on every surface (item 5)", () => {
  it("an epoch that no longer matches the side: '--'", () => {
    expectAll(allFigures({ ...BASE, factors: slabFactors(ADL_ONE / 2n, ADL_ONE, 5n), epochSnap: 3n }), "--");
  });
  it("a prior-reset obligation (ResetPending, epoch_snap + 1 == epoch): '--'", () => {
    expectAll(allFigures({ ...BASE, factors: slabFactors(ADL_ONE / 2n, ADL_ONE, 5n, 2), epochSnap: 4n }), "--");
  });
  it("CONTROL: the same slab with the leg in the current epoch reads +5.00", () => {
    expectAll(allFigures({ ...BASE, factors: slabFactors(ADL_ONE / 2n, ADL_ONE, 5n), epochSnap: 5n }), "+5.00");
  });
  it("a_side above a_basis (the engine's InvalidLeg): '--'", () => {
    expectAll(allFigures({ ...BASE, aBasis: ADL_ONE / 2n, factors: slabFactors(ADL_ONE, ADL_ONE) }), "--");
  });
});

describe("liquidation price is on EFFECTIVE size (item 1)", () => {
  it("dock, builder and helper show the engine price over 40 effective tokens, not over 80 raw", () => {
    const f = allFigures(BASE);
    const eff = computeEngineLiqPrice(BASE.cached, 1_000_000_000n, 40_000_000n, 500n);
    const raw = computeEngineLiqPrice(BASE.cached, 1_000_000_000n, 80_000_000n, 500n);
    expect(eff).not.toBe(raw); // control: the two sizes give different prices
    expect(f.pos.liquidationPriceE6).toBe(eff);
    const { container } = render(<PositionsDock slabAddress={SLAB} />);
    const liq = container.querySelector('[data-testid="position-liq"]')?.textContent ?? "";
    // the dock prints the price trimmed of trailing zeros
    const px = (e6: bigint) => `$${Number(e6) / 1e6}`;
    expect(liq).toContain(px(eff));
    expect(liq).not.toContain(px(raw));
  });

  it("unknown ADL state: no liquidation number on the dock (it falls back to margin health)", () => {
    allFigures({ ...BASE, factors: null });
    const { container } = render(<PositionsDock slabAddress={SLAB} />);
    const liq = container.querySelector('[data-testid="position-liq"]')?.textContent ?? "";
    expect(liq).not.toContain(`$${Number(computeEngineLiqPrice(BASE.cached, 1_000_000_000n, 80_000_000n, 500n)) / 1e6}`);
    expect(liq).not.toContain("∞");
  });
});

describe("ClosePositionModal when the ADL state is unknown (item 3)", () => {
  const openModal = () => {
    const { container } = render(<PositionsDock slabAddress={SLAB} />);
    fireEvent.click(container.querySelector('[data-testid="position-close"]') as HTMLElement);
  };
  it("known ADL: the modal gets the EFFECTIVE size and a live preview", () => {
    allFigures(BASE);
    openModal();
    expect(h.modalProps?.positionSize).toBe(40_000_000n);
    expect(h.modalProps?.previewUnavailable).toBe(false);
  });
  it("unknown ADL: the preview is withheld", () => {
    allFigures({ ...BASE, factors: null });
    openModal();
    expect(h.modalProps?.previewUnavailable).toBe(true);
  });
});

describe("risk tier (margin cushion) is on EFFECTIVE size (follow-up)", () => {
  // Long 80 raw / 40 effective, entry $99.875, mark $91, capital $1,000, mm 5%.
  //  effective: equity 645 / notional 3,640 = 17.7%  -> ~63% of the cushion left (safe)
  //  raw:       equity 290 / notional 7,280 =  4.0%  -> below maintenance (danger)
  const DOWN: Scenario = { ...BASE, mark: 91_000_000n, rawOnChain: 91_000_000n };
  const liqClass = () => {
    const { container } = render(<PositionsDock slabAddress={SLAB} />);
    return container.querySelector('[data-testid="position-liq"]')?.className ?? "";
  };

  it("the dock tier follows the effective size: not danger on an ADL'd position that is fine", () => {
    const { pos } = setup(DOWN);
    const cls = liqClass();
    expect(cls).not.toContain("--short");
    expect(cls).not.toContain("--warning");
    const eff = computeMarginCushion({ positionSize: 40_000_000n, entryPriceE6: 99_875_000n, capital: 1_000_000_000n, markPriceE6: 91_000_000n, maintenanceMarginBps: 500n, initialMarginBps: 1000n });
    const raw = computeMarginCushion({ positionSize: 80_000_000n, entryPriceE6: 99_875_000n, capital: 1_000_000_000n, markPriceE6: 91_000_000n, maintenanceMarginBps: 500n, initialMarginBps: 1000n });
    expect(eff!).toBeGreaterThan(0.5);
    expect(raw!).toBeLessThan(0.25); // control: raw size would have been red
    // the portfolio-side cushion (bar / alert / card) is the same number
    expect(liveMarginCushion(pos, DOWN.mark)).toBe(eff);
  });

  it("NEGATIVE CONTROL: the same move with no ADL (raw == effective) IS danger on the dock", () => {
    setup({ ...DOWN, factors: { aLong: ADL_ONE, aShort: ADL_ONE } });
    expect(liqClass()).toContain("--short");
  });

  it("unknown ADL state: not measurable (null), never a raw-size tier", () => {
    const { pos } = setup({ ...DOWN, factors: null });
    expect(liveMarginCushion(pos, DOWN.mark)).toBeNull();
    const cls = liqClass();
    expect(cls).not.toContain("--short"); // no raw-size "danger"
    // CONTROL: with the factors known the cushion is a number
    expect(liveMarginCushion(setup(DOWN).pos, DOWN.mark)).not.toBeNull();
  });
});

describe("dust positions (Discord: a tiny position read \"SOL 0\" in the positions bar)", () => {
  // 72 base atoms long, entry $150, mark $152: the engine values it at 72 x $2 / 1e6 = 144 atoms
  // ($0.000144). Going through native units first truncated it to 0n, so PnL read 0 and ROE 0.0%.
  const dust = { effectiveSize: 72n, entryE6: 150_000_000n, markE6: 152_000_000n, initialMarginBps: 1_000n, capital: 1_000_000n };

  it("PnL is valued in one division, as the engine does: 144 atoms, not 0, and its real ROE", () => {
    const v = valueAtMark(dust);
    expect(v.unrealizedPnl).toBe(144n);
    // Initial margin: 72 x $150 x 10% = 1080 atoms; 144 / 1080 = 13.33%.
    expect(v.roe).toBeCloseTo(13.33, 1);
  });

  it("a loss on the same dust position is negative, not 0", () => {
    expect(valueAtMark({ ...dust, markE6: 148_000_000n }).unrealizedPnl).toBe(-144n);
  });

  it("a loss that doesn't divide evenly floors like the engine (-1 atom, not 0)", () => {
    // 72 x -$0.000001 = -72 / 1e6 -> floor -1 (truncation toward zero would read 0 again).
    expect(valueAtMark({ ...dust, markE6: 149_999_999n }).unrealizedPnl).toBe(-1n);
    expect(valueAtMark({ ...dust, markE6: 150_000_001n }).unrealizedPnl).toBe(0n);
  });

  it("a short dust position gains when the mark falls", () => {
    expect(valueAtMark({ ...dust, effectiveSize: -72n, markE6: 148_000_000n }).unrealizedPnl).toBe(144n);
  });

  it("the chip shows a dust position's real PnL, not 0 (the Discord report)", () => {
    // 1 base atom (effective) of a $100 market moving to $102: +2 atoms = +0.000002.
    setup({ ...BASE, basis: 1n, cached: 100_000_000n, mark: 102_000_000n, factors: { aLong: ADL_ONE, aShort: ADL_ONE } });
    const { container } = render(<PositionsBar />);
    const bar = container.querySelector('[data-testid="positions-bar"]')!;
    expect(bar.querySelector("span.font-bold")?.textContent?.trim()).toBe("+0.000002");
  });

  it("the chip shows a known zero as 0.00, never a bare 0 (#865), and says what the figure is", () => {
    setup({ ...BASE, cached: 100_000_000n, mark: 100_000_000n, factors: { aLong: ADL_ONE, aShort: ADL_ONE } });
    const { container } = render(<PositionsBar />);
    const bar = container.querySelector('[data-testid="positions-bar"]')!;
    expect(bar.querySelector("span.font-bold")?.textContent?.trim()).toBe("0.00");
    expect(bar.querySelector('[title="Unrealized PnL and return on margin"]')).not.toBeNull();
  });
});
