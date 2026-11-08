/**
 * The PERC token contract address is not published on the site. No
 * client-shippable source may carry a pump.fun-style mint literal (base58,
 * ending in "pump"), and the footer no longer offers a copy-CA button.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "components", "hooks", "lib", "public"];
const PUMP_MINT = /[1-9A-HJ-NP-Za-km-z]{28,40}pump(?![1-9A-HJ-NP-Za-km-z])/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "charting_library") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|json|md|html|txt|xml|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const all = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (p: string) => path.relative(ROOT, p);

describe("PERC contract address is not published", () => {
  it("scanned a real tree (not vacuous)", () => {
    const r = all.map(rel);
    expect(r).toContain("components/layout/Footer.tsx");
    expect(r).toContain("app/layout.tsx");
    expect(r).toContain("app/waitlist/page.tsx");
  });

  it("the pattern catches a pump.fun-style mint", () => {
    expect(PUMP_MINT.test(`const CA = "${"1".repeat(40)}pump";`)).toBe(true);
    expect(PUMP_MINT.test("pump.fun")).toBe(false);
  });

  it("no client-shippable file carries a pump.fun-style mint literal", () => {
    const offenders = all.filter((f) => PUMP_MINT.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the footer has no copy-CA control", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/layout/Footer.tsx"), "utf8");
    expect(src).not.toMatch(/clipboard|copyCA|\bCA\b/);
  });
});
