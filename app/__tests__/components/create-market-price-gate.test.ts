/**
 * Binds the price fix to the source.
 *
 * `__tests__/lib/initial-price.test.ts` covers the rules, but all the
 * interesting logic here is the WIRING: which field each branch prices from,
 * which dependencies re-run the effect, and what gets cleared on a token
 * change. A pure-helper suite cannot see any of that — reverting
 * CreateMarketWizard.tsx entirely leaves every one of those tests green.
 *
 * Same technique, and the same reason, as create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const WIZARD = fs.readFileSync(
  path.resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"),
  "utf8",
);
const QUICK_LAUNCH = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/useQuickLaunch.ts"),
  "utf8",
);

/** Drop comments, so an assertion about CODE is not satisfied by prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function slice(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("every price path goes through the representability check", () => {
  it("the admin/keeper branch uses toInitialPriceE6, not a bare parseFloat", () => {
    const body = slice(WIZARD, "const getOracleFeedAndPrice", "const { priceE6:");
    expect(body).toMatch(/toInitialPriceE6\(\s*wizard\.adminPrice\s*\)/);
    // The old gate collapsed an unrepresentable price to 0n and blamed the feed.
    expect(body).not.toMatch(/parseFloat\(\s*wizard\.adminPrice/);
  });

  it("the hyperp branch uses it too — the sibling that was left behind", () => {
    // This is the assertion that would have caught it: the branch kept a bare
    // toE6(dexPrice), so 8e-7 launched at +25% while 4e-7 blocked with the
    // wrong message. Same number, opposite outcome from the admin path.
    const body = slice(WIZARD, "const getOracleFeedAndPrice", "const { priceE6:");
    expect(body).not.toMatch(/toE6\(\s*dexPrice\s*\)/);
    expect(body).toMatch(/toInitialPriceE6\(/g);
  });

  it("the disabled-reason reads the field the ACTIVE branch prices from", () => {
    // Computing the explanation from adminPrice while the hyperp branch prices
    // from dexPool.priceUsd is how a blocked launch explained itself with an
    // unrelated (usually null) value, i.e. "Waiting on price feed" again.
    const body = slice(WIZARD, "const priceProblem", "const priceBelowMinimum");
    expect(body).toContain("hyperp_ema");
    expect(body).toContain("dexPool");
  });

  it("the disabled-reason surfaces above-maximum, not just below-minimum (#2606)", () => {
    // The helper reports BOTH below-minimum and above-maximum, but the cascade
    // only surfaced below-minimum — so a price > $1,000,000/token fell through to
    // the literal "Waiting on price feed", a message that can never clear. A
    // pure-helper suite can't see this: initial-price.test.ts proves the helper
    // returns above-maximum, but only the WIRING here decides whether the user
    // is told. code() strips comments so this binds to the branch, not the prose.
    const body = code(slice(WIZARD, "const priceBelowMinimum", "Waiting on price feed"));
    expect(body).toMatch(/reason === "above-maximum"/);
    expect(body).toContain("above the $1,000,000 maximum a market can price");
  });
});

describe("M-8: an opening price too small to track is refused at launch", () => {
  it("both launch branches apply the trackable floor at the leverage's cap", () => {
    const body = code(slice(WIZARD, "const getOracleFeedAndPrice", "const { priceE6:"));
    // hyperp (DEX) branch and admin/keeper branch — two call sites.
    expect(body.match(/withTrackableFloor\(\s*toInitialPriceE6\(/g)?.length).toBe(2);
    expect(body.match(/launchPriceMoveBps,\s*floorLotExp,?\s*\)/g)?.length).toBe(2);
  });

  it("the cap is the one create() will set (deriveLaunchMarketParams of the dial)", () => {
    const body = code(slice(WIZARD, "const launchPriceMoveBps", "const feeConflict"));
    expect(body).toMatch(/deriveLaunchMarketParams\(\{\s*initialMarginBps:\s*wizard\.initialMarginBps/);
    expect(body).toContain(".maxPriceMoveBpsPerSlot");
  });

  it("the disabled-reason explains it instead of 'Waiting on price feed'", () => {
    const problem = code(slice(WIZARD, "const priceProblem", "const priceBelowMinimum"));
    expect(problem).toMatch(/withTrackableFloor\(/);
    const cascade = code(slice(WIZARD, "const priceBelowMinimum", "Waiting on price feed"));
    expect(cascade).toMatch(/reason === "below-trackable"/);
    expect(cascade).toMatch(/priceBelowTrackable\s*\?/);
    expect(cascade).toContain("market needs to track its price");
  });
});

describe("a late-arriving price reaches the wizard", () => {
  it("the defaults effect depends on quickLaunch.adminPrice, not config alone", () => {
    // config lands as soon as tokenMeta does; /api/oracle/resolve takes up to
    // 8s, so adminPrice is normally the LATE one. Keyed on config alone, a
    // price that arrived after auto-advance never landed at all — the
    // permanent form of the reported hang.
    expect(WIZARD).toMatch(
      /\}, \[\s*quickLaunch\.config\s*,\s*quickLaunch\.adminPrice\s*\]\)/,
    );
    expect(WIZARD).not.toMatch(/\}, \[\s*quickLaunch\.config\s*\]\)/);
  });

  it("the hook never downgrades a resolved price to null", () => {
    // `setAdminPrice(formatResolvedPrice(data.price))` reintroduced the exact
    // bug one layer up: a 200 carrying price:0 wiped a good value.
    expect(QUICK_LAUNCH).not.toMatch(
      /setAdminPrice\(\s*formatResolvedPrice\(data\.price\)\s*\)/,
    );
    expect(QUICK_LAUNCH).toMatch(
      /setAdminPrice\(\s*\(prev\)\s*=>\s*formatResolvedPrice\(data\.price\)\s*\?\?\s*prev\s*\)/,
    );
  });

  it("no price is carried between hook and wizard through toFixed(6)", () => {
    // That is what turned every sub-5e-7 price into the string "0.000000".
    expect(code(QUICK_LAUNCH)).not.toContain("toFixed(6)");
  });
});

describe("a token change cannot leave the previous token's price behind", () => {
  it("setMintAddress clears adminPrice and the detection state", () => {
    // pickInitialPrice deliberately keeps the last known price rather than
    // downgrading to nothing. That is safe ONLY because this clears it — the
    // launch gate would otherwise pass using the previous token's price, which
    // permanently mis-sizes maxFillAbs/maxInventoryAbs.
    const body = slice(WIZARD, "const setMintAddress", "const setTokenMeta");
    expect(body).toMatch(/adminPrice:\s*null/);
    expect(body).toMatch(/dexPool:\s*null/);
  });
});
