/**
 * #59: in light mode --text-muted (#8A8BA8, 3.1:1 on --bg) and --text-dim (#B8B9CC, 1.8:1) made a lot
 * of secondary text hard to read, including the bottom tab labels. --text-muted now passes 4.5:1 on
 * every light surface, and --text-dim is at least as legible as dark mode's own --text-dim.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf("}", start));
}
function token(src: string, name: string): string {
  const m = src.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`no --${name}`);
  return m[1];
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = block('[data-theme="light"]');
const dark = block(":root");

describe("#59: light-mode secondary text contrast", () => {
  it("--text-muted passes 4.5:1 on every light surface", () => {
    const muted = token(light, "text-muted");
    for (const bg of ["bg", "bg-elevated", "bg-surface", "panel-bg"]) {
      expect(contrast(muted, token(light, bg)), bg).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--text-dim is at least as legible on --bg as in dark mode", () => {
    const lightRatio = contrast(token(light, "text-dim"), token(light, "bg"));
    const darkRatio = contrast(token(dark, "text-dim"), token(dark, "bg"));
    expect(lightRatio).toBeGreaterThanOrEqual(darkRatio);
  });

  it("the grey steps stay ordered: secondary > muted > dim", () => {
    const bg = token(light, "bg");
    const [secondary, muted, dim] = ["text-secondary", "text-muted", "text-dim"].map((t) => contrast(token(light, t), bg));
    expect(secondary).toBeGreaterThan(muted);
    expect(muted).toBeGreaterThan(dim);
  });
});
