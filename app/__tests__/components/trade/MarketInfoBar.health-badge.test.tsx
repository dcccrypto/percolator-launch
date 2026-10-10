/**
 * The ticker-bar badge follows the market status line rendered under it. A settled, close-only,
 * paused or catching-up market used to read green "LIVE" (the badge only knew oracleDown and
 * vaultEmpty) above a line saying new positions are refused.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: null }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => null }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({}) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({}) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({}) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => "" }));
vi.mock("@/components/trade/MarketSwitcher", () => ({ MarketSwitcher: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/trade/TokenCopyMenu", () => ({ TokenCopyMenu: () => null }));

import { healthBadgeState, MarketHealthBadge } from "@/components/trade/MarketInfoBar";
import { marketHeaderStatus } from "@/lib/market-header-status";
import type { MarketHealthRow } from "@/lib/market-health";

const row = (badges: Array<MarketHealthRow["badges"][number]["id"]>): MarketHealthRow =>
  ({ badges: badges.map((id) => ({ id, label: id, detail: "", tone: "warning" })), lockReasons: [], lpDepleted: badges.includes("lp-depleted") } as unknown as MarketHealthRow);

describe("healthBadgeState", () => {
  it("a market the status line reports as not simply live is not badged LIVE", () => {
    expect(healthBadgeState(false, false, marketHeaderStatus(row(["resolved"])))).toBe("settled");
    expect(healthBadgeState(false, false, marketHeaderStatus(row(["adl-reduce-only"])))).toBe("close-only");
    expect(healthBadgeState(false, false, marketHeaderStatus(row(["lp-depleted"])))).toBe("paused");
    expect(healthBadgeState(false, false, { kind: "engine-catching-up", variant: "wait", title: "Catching up", body: "" })).toBe("catching-up");
  });

  it("no status line (healthy, or health unknown) keeps the oracle/vault states", () => {
    expect(healthBadgeState(false, false, marketHeaderStatus(row([])))).toBe("live");
    expect(healthBadgeState(false, false, marketHeaderStatus(null))).toBe("live");
    expect(healthBadgeState(true, false, null)).toBe("no-oracle");
    expect(healthBadgeState(false, true, null)).toBe("no-liquidity");
    expect(healthBadgeState(true, true, null)).toBe("inactive");
  });

  it("an oracle or vault failure outranks the status line, except on a settled market", () => {
    expect(healthBadgeState(true, false, marketHeaderStatus(row(["lp-depleted"])))).toBe("no-oracle");
    expect(healthBadgeState(false, true, marketHeaderStatus(row(["lp-depleted"])))).toBe("no-liquidity");
    // Settled is terminal: everyone closed out (vault empty) or the keeper stopped pushing is normal there.
    expect(healthBadgeState(false, true, marketHeaderStatus(row(["resolved"])))).toBe("settled");
    expect(healthBadgeState(true, true, marketHeaderStatus(row(["resolved"])))).toBe("settled");
  });
});

describe("MarketHealthBadge", () => {
  it("renders the status label and carries the status body as the tooltip", () => {
    const status = marketHeaderStatus(row(["lp-depleted"]));
    render(<MarketHealthBadge oracleDown={false} vaultEmpty={false} status={status} />);
    const badge = screen.getByText("PAUSED").closest("span[title]") as HTMLElement;
    expect(badge.getAttribute("title")).toBe(status?.body);
    expect(screen.queryByText("LIVE")).toBeNull();
  });

  it("CONTROL: a healthy market still reads LIVE", () => {
    render(<MarketHealthBadge oracleDown={false} vaultEmpty={false} status={null} />);
    expect(screen.getByText("LIVE")).toBeTruthy();
  });
});
