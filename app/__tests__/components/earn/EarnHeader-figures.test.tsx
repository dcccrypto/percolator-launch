/**
 * Discord report: the Earn TVL read "anywhere from $198K to $415K". The header counted each figure
 * up from $0 (and again on every 15 s poll), so a glance could catch any value on the way. The
 * figures now show as they are, on first render.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EarnHeader } from "@/components/earn/EarnHeader";

const stats = { markets: [], tvl: 550_431.4, dailyFeeRevenue: 1_234.6, totalInsurance: 98_765, totalOI: 0, maxOI: 0 } as never;

describe("EarnHeader figures", () => {
  it("shows TVL, daily fees and insurance at their values straight away, not counting up from $0", () => {
    render(<EarnHeader stats={stats} loading={false} />);
    expect(screen.getByText((550_431).toLocaleString(), { exact: false })).toBeTruthy();
    expect(screen.getByText(`$${(1_235).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`$${(98_765).toLocaleString()}`)).toBeTruthy();
    expect(screen.queryByText("$0")).toBeNull();
  });
});
