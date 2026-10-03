/**
 * Structural guard: every component that renders a liquidation price goes
 * through the shared display (lib/liq-price-display.ts -> describeLiqPrice).
 *
 * #2558 fixed four surfaces and guarded them with a hand-written list, which is
 * why five more went unnoticed (#2634): a list only proves things about itself.
 * This test DISCOVERS the surfaces by scanning components/ and app/ for
 * liquidation-price renders, so a new surface is covered the day it is written
 * and fails here until it uses the shared display (or is exempted, in writing,
 * below).
 *
 * `__tests__/lib/liq-price-display.test.ts` covers the derivation; this file
 * covers the wiring — reverting a surface leaves the formula suites green.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const APP_ROOT = path.resolve(__dirname, "../../");
const SCAN_DIRS = ["components", "app"];

/** Recursively list .ts/.tsx files, skipping build output and deps. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Drop comments so a mention in prose is not mistaken for a render. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * A "liquidation price" identifier or label: liqPriceE6, afterLiqPrice,
 * liquidationPriceE6, formatLiqPrice, "Liq. Price", "Liquidation Price"...
 * plus the chart's `title: "Liq"` price-line label.
 */
const LIQ_PRICE_RE = /liq(?:uidation)?[\s._-]{0,2}price|title:\s*["']Liq["']/i;

export function rendersLiqPrice(src: string): boolean {
  return LIQ_PRICE_RE.test(stripComments(src));
}

export function usesSharedLiqDisplay(src: string): boolean {
  return stripComments(src).includes("describeLiqPrice(");
}

/**
 * Surfaces that render a liquidation price WITHOUT the shared display. Each
 * needs a reason, and the reason is re-checked below (an exemption that stops
 * matching is stale and fails). Adding to this list is a decision to make
 * explicitly, in review — not a way to make the test pass.
 */
const EXEMPT: Record<string, string> = {
  "components/trade/TradingChart.tsx":
    "Draws a price LINE only when a real price exists (useLiqPrice is null for the covered case, so there is no '—'/'∞' to explain); its title cannot carry health without making the series-rebuild effect depend on the mark. #2634 item 3.",
  "components/trade/tv/TvChart.tsx":
    "TradingView twin of TradingChart's Liq line: a locked horizontal LINE drawn only when a real price exists (usePositionLinePrices -> null for the covered case; desiredLines skips null/<=0), same premise as the TradingChart exemption.",
};

const rel = (abs: string) => path.relative(APP_ROOT, abs).split(path.sep).join("/");
const sources = SCAN_DIRS.flatMap((d) => walk(path.join(APP_ROOT, d))).map((abs) => ({
  file: rel(abs),
  src: fs.readFileSync(abs, "utf8"),
}));
/** The presentational sink of the shared display — it renders what describeLiqPrice built. */
const SHARED_SINK = "components/trade/LiqPriceValue.tsx";
const surfaces = sources.filter(({ file, src }) => file !== SHARED_SINK && rendersLiqPrice(src));

describe("the scanner itself", () => {
  it("flags a liquidation-price render and ignores prose mentions", () => {
    expect(rendersLiqPrice(`const x = formatUsd(pos.liquidationPriceE6);`)).toBe(true);
    expect(rendersLiqPrice(`<th>Liq. Price</th>`)).toBe(true);
    expect(rendersLiqPrice(`<th>Liquidation Price</th>`)).toBe(true);
    expect(rendersLiqPrice(`createPriceLine({ title: "Liq" })`)).toBe(true);
    expect(rendersLiqPrice(`// the liq price is clamped\n/* liquidation price */ const y = 1;`)).toBe(false);
    expect(rendersLiqPrice(`const distance = liquidationDistancePct;`)).toBe(false);
  });

  it("only accepts describeLiqPrice as the shared path", () => {
    expect(usesSharedLiqDisplay(`const d = describeLiqPrice({ liqPriceE6 });`)).toBe(true);
    expect(usesSharedLiqDisplay(`// describeLiqPrice(\nconst t = formatUsd(liqPriceE6);`)).toBe(false);
  });

  it("discovers at least the nine known surfaces (guards against a broken scan)", () => {
    const files = surfaces.map((s) => s.file);
    for (const known of [
      "components/trade/PositionPanel.tsx",
      "components/trade/PositionsDock.tsx",
      "components/trade/OtherMarketPositions.tsx",
      "components/portfolio/PortfolioPositionsView.tsx",
      "components/dashboard/PositionSummary.tsx",
      "components/trade/AccountsCard.tsx",
      "components/trade/OrderTicket.tsx",
      "components/trade/TradingChart.tsx",
      "components/trade/TradeConfirmationModal.tsx",
    ]) {
      expect(files, `scan should discover ${known}`).toContain(known);
    }
  });
});

describe("every component that renders a liquidation price uses the shared display", () => {
  const nonExempt = surfaces.filter(({ file }) => !(file in EXEMPT));

  it.each(nonExempt.map(({ file, src }) => [file, src] as const))(
    "%s derives it via describeLiqPrice",
    (_file, src) => {
      expect(usesSharedLiqDisplay(src)).toBe(true);
    },
  );

  it("no component formats a liquidation price by hand (formatLiqPrice is internal to the shared display)", () => {
    const offenders = sources
      .filter(({ src }) => /\bformatLiqPrice\b/.test(stripComments(src)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe("exemptions are explicit and current", () => {
  it.each(Object.entries(EXEMPT))("%s is still a liquidation-price surface, and has a reason", (file, reason) => {
    expect(reason.trim().length).toBeGreaterThan(40);
    const hit = surfaces.find((s) => s.file === file);
    expect(hit, `${file} no longer renders a liquidation price — remove the exemption`).toBeDefined();
    // If it starts using the shared display, the exemption is dead weight.
    expect(usesSharedLiqDisplay(hit!.src), `${file} now uses the shared display — remove the exemption`).toBe(false);
  });

  it("the chart really does hide the line when there is no price (the premise of its exemption)", () => {
    const hook = fs.readFileSync(path.join(APP_ROOT, "hooks/useLiqPrice.ts"), "utf8");
    expect(hook).toMatch(/return liq > 0n \? liq : null;/);
    const chart = sources.find((s) => s.file === "components/trade/TradingChart.tsx")!.src;
    expect(chart).toMatch(/liqPriceE6 != null && liqPriceE6 > 0n/);
    // TradingView chart: same rule, in the hook that feeds its Liq line and in the line planner.
    const tvHook = fs.readFileSync(path.join(APP_ROOT, "hooks/usePositionLinePrices.ts"), "utf8");
    expect(tvHook).toMatch(/liqE6 != null && liqE6 > 0n/);
    const tvLines = fs.readFileSync(path.join(APP_ROOT, "lib/tv/positionLines.ts"), "utf8");
    expect(tvLines).toMatch(/if \(i\.prefs\.liq && valid\(i\.liqPrice\)\)/);
  });
});

describe("the health formula and threshold live in one place", () => {
  it("no component re-derives capital/notional or hard-codes the 105% threshold", () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      expect(code, `${file} re-derives margin health`).not.toMatch(
        /capital\s*\*\s*1_000_000n\s*\*\s*100n\s*\/\s*notionalE6/,
      );
      if (rendersLiqPrice(src)) {
        expect(code, `${file} hard-codes the health threshold`).not.toMatch(/\b105\s*%/);
      }
    }
  });

  it("the '% mgn' readout is produced only by the shared display", () => {
    const offenders = sources.filter(({ src }) => stripComments(src).includes("% mgn")).map(({ file }) => file);
    expect(offenders).toEqual([]);
    const lib = fs.readFileSync(path.join(APP_ROOT, "lib/liq-price-display.ts"), "utf8");
    expect(lib).toContain("% mgn");
  });
});
