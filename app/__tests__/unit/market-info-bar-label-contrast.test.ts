/**
 * #60: the trade page's top stats labels (Vol 24h, Open Interest, 24h High / Low, Spread,
 * Funding / 8h) were 9px in --text-dim (2.55:1 dark, 1.83:1 light). They now use --text-muted at
 * 10px, like the rest of the bar's small text.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../components/trade/MarketInfoBar.tsx"), "utf8");
const LABELS = ["Vol 24h", "Open Interest", "24h High", "24h Low", "Spread", "Funding / 8h"];

describe("#60: MarketInfoBar stat labels", () => {
  for (const label of LABELS) {
    it(`"${label}" uses --text-muted at 10px`, () => {
      const m = src.match(new RegExp(`<span className="([^"]*)">${label.replace("/", "\\/")}</span>`));
      expect(m, label).not.toBeNull();
      const cls = m![1].split(/\s+/);
      expect(cls).toContain("text-[var(--text-muted)]");
      expect(cls).toContain("text-[10px]");
    });
  }
});
