// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResolvedClaimPanelView } from "@/components/trade/ResolvedClaimPanel";
import { RecoverToStakersView } from "@/components/stake/RecoverToStakers";
import { EarnFloorNote } from "@/components/my-markets/CreatorMarketRow";
import { planClaimRows } from "@/lib/v22/resolved-claims";

vi.mock("@/components/providers/SlabProvider", () => ({ SlabProvider: ({ children }: { children: unknown }) => children, useSlabState: () => ({}) }));

const market = { mode: 1, resolvedSlot: 1n, forceCloseDelaySlots: 216_000n, cTot: 1n, materializedPortfolioCount: 1n };
const base = { slabAddress: "Slab111", walletConnected: true, loading: false, busy: false, error: null, done: null, waiting: null, onClose: () => undefined };

describe("ResolvedClaimPanelView", () => {
  it("lists positions, Earn and stake in that order with their next action", () => {
    const rows = planClaimRows(market, { positions: 1, earnShares: 5n, stakeShares: 5n, stakeNeedsRecover: true });
    render(<ResolvedClaimPanelView {...base} rows={rows} window={{ configured: true, ownerOnly: true, endsAtSlot: 9n, endsAtMs: Date.now() + 3_600_000 }} />);
    const order = screen.getAllByTestId(/^claim-row-/).map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["claim-row-positions", "claim-row-earn", "claim-row-stake"]);
    expect(screen.getByTestId("claim-action-close-and-withdraw")).toBeTruthy();
    expect(screen.getByTestId("claim-action-recover-to-stakers")).toBeTruthy();
    expect(screen.getByTestId("claim-waiting").textContent).toMatch(/open positions/);
    expect(screen.getByTestId("claim-owner-window").textContent).toMatch(/After that, anyone can settle a position/);
  });
  it("only the Close button sends; it calls onClose", () => {
    const onClose = vi.fn();
    render(<ResolvedClaimPanelView {...base} onClose={onClose} rows={planClaimRows(market, { positions: 1, earnShares: 0n, stakeShares: 0n, stakeNeedsRecover: false })} window={null} />);
    fireEvent.click(screen.getByTestId("claim-action-close-and-withdraw"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("says so when nothing of the wallet's is left", () => {
    render(<ResolvedClaimPanelView {...base} rows={planClaimRows(market, { positions: 0, earnShares: 0n, stakeShares: 0n, stakeNeedsRecover: false })} window={null} />);
    expect(screen.getByTestId("claim-none")).toBeTruthy();
  });
});

describe("RecoverToStakersView", () => {
  it("renders nothing on a live pool; shows the button on a settled one, disabled while positions are open", () => {
    const { container, rerender } = render(<RecoverToStakersView offer={false} blockedByPositions={false} busy={false} error={null} done={null} canAct onRecover={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RecoverToStakersView offer blockedByPositions={false} busy={false} error={null} done={null} canAct onRecover={() => undefined} />);
    expect((screen.getByTestId("recover-to-stakers-button") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("recover-to-stakers-button").textContent).toBe("Recover to stakers");
    rerender(<RecoverToStakersView offer blockedByPositions busy={false} error={null} done={null} canAct onRecover={() => undefined} />);
    expect((screen.getByTestId("recover-to-stakers-button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("EarnFloorNote (creator row)", () => {
  it("says rent is not reclaimable and offers settle only to the admin", () => {
    const { rerender } = render(<EarnFloorNote canSettle busy={false} onSettle={() => undefined} />);
    expect(screen.getByTestId("earn-floor-line").textContent).toMatch(/^Rent is not reclaimable on v2\.2 Earn markets/);
    expect(screen.getByTestId("settle-and-withdraw-button").textContent).toBe("Settle and withdraw everything");
    rerender(<EarnFloorNote canSettle={false} busy={false} onSettle={() => undefined} />);
    expect(screen.queryByTestId("settle-and-withdraw-button")).toBeNull();
  });
});
