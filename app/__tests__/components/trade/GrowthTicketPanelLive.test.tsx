import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const slot = vi.hoisted(() => ({ value: 1_000_000n as bigint | null, enabledArg: undefined as boolean | undefined }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: (enabled?: boolean) => { slot.enabledArg = enabled; return slot.value; } }));

import { GrowthTicketPanelLive } from "@/components/trade/GrowthTicketPanelLive";
import { growthMarketView, growthTicketDecision } from "@/lib/v21/growth-market";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ENGINE, LP, marketRaw } from "../../lib/v21/fixtures";

beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
  slot.value = 1_000_000n;
});
const raw = marketRaw({ launch: 300, ceil: 300, gap: 397 });
const view = growthMarketView({ raw, engine: ENGINE, lp: LP, lpEffectiveQ: -1_000_000n, bound: true })!;
const decision = growthTicketDecision(view, "long", 0n, 1_000_000n);
const props = { view, decision, direction: "long" as const };

describe("GrowthTicketPanelLive", () => {
  it("rules deployed + band market: the badge and the unlock line appear once the slot is known", () => {
    render(<GrowthTicketPanelLive {...props} bandBps={130} rulesDeployed />);
    expect(screen.getByTestId("growth-tier")).toHaveTextContent("Liquidity tier 0");
    expect(screen.getByTestId("growth-unlock")).toBeInTheDocument();
  });
  it("rules not deployed yet: the program does not apply the tiers, so nothing is promised and no slot is polled", () => {
    render(<GrowthTicketPanelLive {...props} bandBps={130} rulesDeployed={false} />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
    expect(slot.enabledArg).toBe(false);
  });
  it("no band view or an off-band market: no badge, no unlock line", () => {
    const { rerender } = render(<GrowthTicketPanelLive {...props} bandBps={null} rulesDeployed />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    rerender(<GrowthTicketPanelLive {...props} bandBps={0} rulesDeployed />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
  });
  it("clock unknown: no badge", () => {
    slot.value = null;
    render(<GrowthTicketPanelLive {...props} bandBps={130} rulesDeployed />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
  });
});
