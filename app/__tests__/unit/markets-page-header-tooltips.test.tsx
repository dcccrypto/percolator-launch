/**
 * /markets column headers: only VAULT explained itself on hover. Every metric header now carries
 * a tooltip saying what it measures, in the same `title` form as VAULT.
 *
 * HEALTH's tooltip is built from HealthBadge's own labels (HEALTH_HEADER_TOOLTIP), so it names
 * exactly the badges the column renders. A hand-written copy said "Low Liquidity" and "No Oracle"
 * (never rendered; the badges read "Low Liq" and "Awaiting price") and left out "Empty".
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { render } from "@testing-library/react";
import { BANNED } from "@/__tests__/lib/banned-terms-harvest";
import { HealthBadge, HEALTH_HEADER_TOOLTIP, HEALTH_LABELS } from "@/components/market/HealthBadge";
import type { HealthLevel } from "@/lib/health";

const src = fs.readFileSync(path.resolve(__dirname, "../../app/markets/page.tsx"), "utf8");
const header = src.slice(src.indexOf("<div>token</div>"), src.indexOf("health</div>") + "health</div>".length);

const titleOf = (label: RegExp) => {
  const m = header.match(new RegExp(`title="([^"]+)">${label.source}`));
  return m ? m[1] : null;
};

// Every level the /markets row can pass to <HealthBadge level=…> (computeMarketHealth*,
// the "No data" fallback, and the oracle-down override).
const LEVELS: HealthLevel[] = ["healthy", "caution", "warning", "empty", "oracle-down"];

/** The text a rendered badge actually shows. */
const badgeText = (level: HealthLevel) => {
  const { container, unmount } = render(<HealthBadge level={level} />);
  const text = container.textContent?.trim() ?? "";
  unmount();
  return text;
};

describe("/markets column header tooltips", () => {
  it.each([
    ["price", /price</],
    ["OI", /OI</],
    ["vol", /vol</],
    ["vault", /vault</],
    ["max lev", /<span className="sm:hidden">lev</],
  ])("%s has a tooltip", (_name, label) => {
    expect(titleOf(label)).toBeTruthy();
  });

  it("health uses the tooltip built from the badge labels", () => {
    expect(header).toMatch(/title=\{HEALTH_HEADER_TOOLTIP\}>health</);
    expect(src).toMatch(/import \{[^}]*\bHEALTH_HEADER_TOOLTIP\b[^}]*\} from "@\/components\/market\/HealthBadge"/);
  });

  it("OI and vol say they follow the USD / tokens filter", () => {
    expect(titleOf(/OI</)).toMatch(/open interest/i);
    expect(titleOf(/OI</)).toMatch(/USD or in tokens/);
    expect(titleOf(/vol</)).toMatch(/24 hours/);
    expect(titleOf(/vol</)).toMatch(/USD or in tokens/);
  });

  it.each(LEVELS)("health tooltip names the %s badge exactly as it renders", (level) => {
    const shown = badgeText(level);
    expect(shown).toBe(HEALTH_LABELS[level]);
    expect(HEALTH_HEADER_TOOLTIP).toContain(shown);
  });

  it("health tooltip names no label the column never renders", () => {
    // These are lib/health.ts `.label` / the oracle-down object's label; the row never shows them.
    for (const unseen of ["Low Liquidity", "No Oracle", "No data", "oracle"]) {
      expect(HEALTH_HEADER_TOOLTIP).not.toContain(unseen);
    }
  });

  it("no tooltip uses a banned term", () => {
    const titles = [...header.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles.length).toBe(5);
    titles.push(HEALTH_HEADER_TOOLTIP);
    for (const t of titles) for (const [term, re] of BANNED) expect(t, term).not.toMatch(re);
  });
});
