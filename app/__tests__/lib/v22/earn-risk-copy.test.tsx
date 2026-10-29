/** D2 / D3 (v22 deep memo 2026-10-29): the LP stop notice, plain Earn risk wording, and the backtest only on its own page. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { COPY } from "@/lib/limits/copy";
import { V22_COPY } from "@/lib/v22/copy";
import { EARN_RISK_PAGE } from "@/lib/v22/earn-risk-page";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const read = (rel: string): string => readFileSync(`${process.cwd()}/${rel}`, "utf8");
const NOTICE = "If this market's liquidity loses half its value, positions on the winning side can be reduced at the market price, all by the same percentage.";

afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

describe("D2: the LP stop notice", () => {
  it("is the memo wording, verbatim", () => {
    expect(V22_COPY.lpStop.notice).toBe(NOTICE);
  });
  it("Earn header (v2.2 on) shows it with the link to the risk page; flag off shows neither", async () => {
    const { EarnHeader } = await vi.importActual<typeof import("@/components/earn/EarnHeader")>("@/components/earn/EarnHeader");
    const stats = { markets: [], tvl: 1, dailyFeeRevenue: 1, totalInsurance: 1, totalOI: 0, maxOI: 0, unvaluedSymbols: [] } as never;
    __setDevnetV22ForTest(true);
    render(<EarnHeader stats={stats} loading={false} />);
    expect(screen.getByTestId("earn-lp-stop").textContent).toContain(NOTICE);
    expect(screen.getByTestId("earn-risk-link").getAttribute("href")).toBe("/earn/risk");
    cleanup();
    __setDevnetV22ForTest(false);
    render(<EarnHeader stats={stats} loading={false} />);
    expect(screen.queryByTestId("earn-lp-stop")).toBeNull();
  });
  it("the trade ticket panel renders it (v2.2 on)", () => {
    const src = read("components/trade/GrowthTicketPanel.tsx");
    expect(src).toContain("V22_COPY.lpStop.notice");
    expect(src).toMatch(/isDevnetV22Enabled\(\) && .*growth-lp-stop/s);
  });
});

describe("D3: Earn risk wording", () => {
  it("says plainly you can lose most of your deposit, and why, with no figure", async () => {
    const { EarnHeader } = await vi.importActual<typeof import("@/components/earn/EarnHeader")>("@/components/earn/EarnHeader");
    __setDevnetV22ForTest(true);
    render(<EarnHeader stats={{ markets: [], tvl: 1, dailyFeeRevenue: 1, totalInsurance: 1, totalOI: 0, maxOI: 0, unvaluedSymbols: [] } as never} loading={false} />);
    const line = screen.getByTestId("earn-loss-line").textContent ?? "";
    expect(line).toMatch(/You can lose most of your deposit/);
    expect(line).toMatch(/can fall when traders win/);
    expect(line).toMatch(/afford to lose/i);
    expect(line).not.toMatch(/\d\s?%/);
  });
  it("the 27-30% backtest appears on the risk page copy, labelled, and nowhere in the deposit flow", () => {
    const p = EARN_RISK_PAGE.backtest.join(" ");
    expect(p).toContain("2,245 seven-day windows");
    expect(p).toMatch(/30%/);
    expect(p).toMatch(/27%/);
    expect(p).toMatch(/44% to 57%/);
    expect(EARN_RISK_PAGE.backtestLabel).toBe("Backtest on past prices, not a floor or a promise.");
    expect(EARN_RISK_PAGE.backtestEnd).toMatch(/say nothing about what will happen to your deposit/);
    const flow = [
      "lib/earn-vault-page.ts",
      "components/trade/GrowthTicketPanel.tsx",
      ...readdirSync(`${process.cwd()}/components/earn`).filter((f) => f.endsWith(".tsx")).map((f) => `components/earn/${f}`),
    ];
    // The deposit-flow copy objects (the whole copy files carry unrelated percentages).
    const objs = [V22_COPY.earnRisk, V22_COPY.lpStop, V22_COPY.earnPage, COPY.howLossesWork, COPY.earnRiskP3].map((o) => JSON.stringify(o));
    for (const t of objs) {
      expect(t).not.toMatch(/\b(27|30)\s?%/);
      expect(t).not.toMatch(/worst (week|case)|backtest/i);
    }
    for (const f of flow) {
      const t = read(f);
      expect(t, f).not.toMatch(/\b(27|30)\s?%/);
      expect(t, f).not.toMatch(/worst (week|case)/i);
    }
  });
  it("the vault page (the deposit flow) states the plain risk and the stop notice, and links to the risk page", () => {
    const t = read("app/earn/[slab]/page.tsx");
    expect(t).toContain("V22_COPY.earnRisk.line");
    expect(t).toContain("V22_COPY.lpStop.notice");
    expect(t).toContain("V22_COPY.earnRisk.linkHref");
  });
  it("the page is wired: route file renders the page copy and the label", () => {
    const t = read("app/earn/risk/page.tsx");
    expect(t).toContain("P.backtestLabel");
    expect(t).toContain("P.stop");
  });
});
