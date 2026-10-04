/**
 * UX WP-10 (audit §4.3): ONE status line under the market header, only when the market is not
 * live, in priority settled > close-only > catching up > side paused > both paused; the rest of
 * the old banner / strip lives in "Market details". Lists show Close-only / Paused / Settled only.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MarketHeaderStatusView, MarketHealthBadges } from "@/components/market/MarketHealthBadges";
import { marketHeaderStatus } from "@/lib/market-header-status";
import type { HealthBadge, MarketHealthRow } from "@/lib/market-health";

const b = (id: HealthBadge["id"], label = id): HealthBadge => ({ id, label, tone: "warning", detail: "d" });
const row = (badges: HealthBadge[]): MarketHealthRow => ({
  lpCapital: "1", lpDepleted: false, payoutHaircutBps: 0, openProfitAtoms: "0", realizableProfitAtoms: "0", lockReasons: [], badges,
});

describe("marketHeaderStatus priority", () => {
  it("live (or only informational badges like the payout level) -> nothing", () => {
    expect(marketHeaderStatus(row([]))).toBeNull();
    expect(marketHeaderStatus(row([b("payout-haircut", "Payout haircut 41%")]))).toBeNull();
    expect(marketHeaderStatus(null)).toBeNull();
  });
  it("settled > close-only > LP depleted > catching up > side paused > both paused", () => {
    const all = [b("drain-only", "Long close-only"), b("loss-stale"), b("lp-depleted"), b("adl-reduce-only"), b("resolved")];
    expect(marketHeaderStatus(row(all))?.title).toBe("Market settled");
    expect(marketHeaderStatus(row(all.slice(0, 4)))?.title).toBe("Close-only for now");
    expect(marketHeaderStatus(row(all.slice(0, 3)))).toMatchObject({ title: "New positions paused", kind: "lp-halt" });
    expect(marketHeaderStatus(row(all.slice(0, 2)))).toMatchObject({ title: "Catching up", variant: "wait" });
    expect(marketHeaderStatus(row(all.slice(0, 1)))).toMatchObject({ title: "New longs paused", body: "The market has no room for more long exposure. Shorts and closes work." });
    expect(marketHeaderStatus(row([b("lp-depleted")]))?.title).toBe("New positions paused");
    expect(marketHeaderStatus(row([b("drain-only", "Long & Short close-only")]))?.title).toBe("New positions paused");
  });
  it("A-1: the bankruptcy h-lock is never a header state (it does not gate trading)", () => {
    expect(marketHeaderStatus(row([b("bankruptcy", "LP withdrawals paused")]))).toBeNull();
    // NEGATIVE CONTROL: the genuine transient states still show.
    expect(marketHeaderStatus(row([b("bankruptcy"), b("repairable")]))?.title).toBe("Catching up");
    expect(marketHeaderStatus(row([b("bankruptcy"), b("loss-stale")]))?.title).toBe("Catching up");
  });
  it("A-3 (Agency): bankruptcy + LP depleted names the LP, not 'Catching up'", () => {
    const st = marketHeaderStatus(row([b("bankruptcy"), b("lp-depleted")]));
    expect(st).toMatchObject({ kind: "lp-halt", title: "New positions paused" });
    // NEGATIVE CONTROL: LP depleted also outranks a genuine catching-up state.
    expect(marketHeaderStatus(row([b("repairable"), b("lp-halted")]))?.kind).toBe("lp-halt");
  });
  it("A-4: ADL copy no longer promises 'within minutes'", () => {
    const st = marketHeaderStatus(row([b("adl-reduce-only")]))!;
    expect(st.body).not.toMatch(/minute/i);
    expect(st.body).toMatch(/once the positions on one side of the market have closed/);
    expect(st.body).toMatch(/Closing works/);
  });
  it("renders one StatusLine keeping the legacy testid; nothing when live", () => {
    const { container, rerender } = render(<MarketHeaderStatusView row={row([])} />);
    expect(container.innerHTML).toBe("");
    rerender(<MarketHeaderStatusView row={row([b("adl-reduce-only"), b("lp-halted")])} />);
    expect(screen.getAllByTestId("status-line")).toHaveLength(1);
    expect(screen.getByTestId("status-line").getAttribute("data-legacy-testid")).toBe("market-health-banner");
    expect(screen.getByTestId("status-line").dataset.kind).toBe("adl-reduce-only");
  });
  it("lists show only Close-only / Paused / Settled", () => {
    render(<MarketHealthBadges row={row([b("payout-haircut"), b("loss-stale"), b("resolved"), b("lp-halted")])} hideInfo />);
    expect(screen.getAllByTestId("market-health-badge").map((e) => e.getAttribute("data-badge"))).toEqual(["resolved", "lp-halted"]);
  });
  it("the trade page renders the header status and keeps the strip + health lines inside Market details", () => {
    const page = readFileSync(resolve(process.cwd(), "app/trade/[slab]/page.tsx"), "utf8");
    const details = page.slice(page.indexOf('data-testid="market-details"'), page.indexOf("</details>"));
    expect(page).toContain("<MarketHeaderStatus slab={slab} />");
    expect(details).toContain("<TradeMarketHealthBanner slab={slab} />");
    expect(details).toContain("<MarketLimitsStrip slab={slab} symbol={symbol} />");
    expect(page.indexOf("<MarketInfoBar")).toBeLessThan(page.indexOf("<MarketHeaderStatus"));
  });
});
