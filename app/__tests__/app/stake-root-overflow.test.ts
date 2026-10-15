/**
 * Earn → Fee Staking showed two full-height scrollbars: the page's, and a second one starting
 * just under the Vaults / Fee Staking tab bar. The Stake page root was `overflow-x-hidden`, and
 * `overflow-x: hidden` makes overflow-y compute to `auto`, so the root was its own vertical
 * scroll container: any overflow inside it drew a second bar. Measured in Chromium at
 * 1362x617 (/earn#stake): root computed overflow-y `auto`; 40px of overflow inside it added a
 * second scroller at the root's top; with `overflow-x: clip` only the page scrolled.
 *
 * Source-binding (jsdom does no layout), scoped to the two elements: the root StakePage
 * returns (followed by its "Compact header" comment) and the right rail (its "RIGHT RAIL"
 * comment). A comment or another element elsewhere cannot satisfy it.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(path.resolve(__dirname, "../../app/stake/page.tsx"), "utf8");

function classesBefore(anchor: RegExp): string[] {
  const m = anchor.exec(SRC);
  expect(m, `anchor ${anchor} not found`).not.toBeNull();
  return m![1].split(/\s+/).filter(Boolean);
}

describe("Fee Staking page root is not a scroll container (double scrollbar)", () => {
  const root = classesBefore(/<div className="([^"]*)">\s*\{\/\* Compact header/);

  it("clips horizontal overflow with overflow-x-clip, not overflow-x-hidden", () => {
    expect(root).toContain("overflow-x-clip");
    expect(root).not.toContain("overflow-x-hidden");
  });

  it("sets no class that would make it scroll vertically", () => {
    expect(root.some((c) => /^overflow-(y-)?(auto|scroll|hidden)$/.test(c))).toBe(false);
  });
});

describe("the right rail keeps scrolling with the page", () => {
  it("is not sticky (it never stuck inside the old root; sticking now would slide under the header)", () => {
    // "RIGHT RAIL — deposit/withdraw": the rail's own comment ("MAIN … + RIGHT RAIL (" above it is the grid's).
    const rail = classesBefore(/RIGHT RAIL — deposit\/withdraw[\s\S]*?\*\/\}\s*<div className="([^"]*)">/);
    expect(rail).toContain("space-y-3");
    expect(rail.some((c) => /sticky|^lg:top-/.test(c))).toBe(false);
  });
});
