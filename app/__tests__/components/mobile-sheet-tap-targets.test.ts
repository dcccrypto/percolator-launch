/**
 * The mobile order sheet's leverage presets were 10px-wide tap targets (8px text,
 * no padding) and the sheet's close ✕ was 13px wide. Measured at 390x844 after the
 * fix: presets 26-30px wide with the label text at the same x, ✕ 40px wide, sheet
 * header height unchanged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("mobile order sheet tap targets", () => {
  it("leverage presets pad the hit area without moving the label (-mx-2 px-2)", () => {
    const src = read("components/trade/OrderTicket.tsx");
    const preset = src.slice(src.indexOf('data-testid="trade-leverage-preset"'));
    expect(preset.slice(0, 400)).toContain("className={`-mx-2 px-2 text-[8px]");
  });

  it("the sheet's close button is a 40px box", () => {
    const src = read("app/trade/[slab]/page.tsx");
    const close = src.slice(0, src.indexOf('aria-label="Close"'));
    expect(close.slice(close.lastIndexOf("<button"))).toContain("flex h-10 w-10 items-center justify-center");
  });
});
