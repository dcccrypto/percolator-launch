/**
 * GH#3189 — Create Market / Control Room dial values became unreadable in
 * light mode.
 *
 * Root cause: the inset LCD face stayed dark while its value inherited the
 * global --text token. Light mode intentionally makes --text near-black, so
 * the 13px readout became dark-on-dark.
 *
 * The LCD is an intentionally dark instrument surface in either theme. Its
 * foreground/background therefore have a dedicated contrast contract rather
 * than inheriting the page text colour.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(__dirname, "../../app/globals.css"),
  "utf8",
);

const ROTARY_DIAL = readFileSync(
  join(__dirname, "../../components/create/RotaryDial.tsx"),
  "utf8",
);

function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing CSS block: ${selector}`);

  const end = CSS.indexOf("}", start);
  if (end < 0) throw new Error(`unterminated CSS block: ${selector}`);

  return CSS.slice(start, end);
}

function maybeToken(src: string, name: string): string | null {
  const match = src.match(
    new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`),
  );

  return match?.[1] ?? null;
}

function token(src: string, name: string): string {
  const value = maybeToken(src, name);

  if (!value) throw new Error(`missing CSS token: --${name}`);
  return value;
}

function effectiveToken(
  root: string,
  theme: string,
  name: string,
): string {
  return maybeToken(theme, name) ?? token(root, name);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );

  const linear = (c: number) =>
    c <= 0.03928
      ? c / 12.92
      : ((c + 0.055) / 1.055) ** 2.4;

  return (
    0.2126 * linear(r) +
    0.7152 * linear(g) +
    0.0722 * linear(b)
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);

  return (hi + 0.05) / (lo + 0.05);
}

const dark = block(":root");
const light = block('[data-theme="light"]');

describe("GH#3189 — RotaryDial LCD readout contrast", () => {
  it("wires the inset LCD to dedicated foreground/background tokens", () => {
    expect(ROTARY_DIAL).toContain(
      "bg-[var(--dial-readout-bg)]",
    );
    expect(ROTARY_DIAL).toContain(
      "text-[var(--dial-readout-text)]",
    );
  });

  it("positive control: the dedicated LCD pair is readable in dark mode", () => {
    expect(
      contrast(
        token(dark, "dial-readout-text"),
        token(dark, "dial-readout-bg"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("regression: the effective LCD pair stays readable in light mode", () => {
    const lcdText = effectiveToken(
      dark,
      light,
      "dial-readout-text",
    );
    const lcdBg = effectiveToken(
      dark,
      light,
      "dial-readout-bg",
    );

    expect(contrast(lcdText, lcdBg)).toBeGreaterThanOrEqual(4.5);
  });
});
