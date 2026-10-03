/**
 * The dock's wrapped-position banner told users to "burn it in the Position NFT panel", a panel
 * removed in UX WP-9. Unwrap now lives in the position row's ⋯ menu (PositionNftMenu).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("wrapped-position hint in the positions dock", () => {
  it("points at the ⋯ menu's Unwrap, not the removed panel", () => {
    const dock = read("components/trade/PositionsDock.tsx");
    expect(dock).not.toMatch(/in the Position NFT panel/);
    expect(dock).toContain("Unwrap it from the ⋯ menu to close");
  });

  it("the menu it names exists with that button and action", () => {
    const menu = read("components/trade/PositionNftMenu.tsx");
    expect(menu).toMatch(/>\s*⋯\s*<\/button>/);
    expect(menu).toContain('unwrap: "Unwrap"');
  });
});
