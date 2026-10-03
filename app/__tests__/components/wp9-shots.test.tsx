/**
 * UX WP-9 screenshots from the REAL components: "Your creator stake" (withdrawable, and a fork
 * state with its reason line), the resolved stake, the close-market checklist, the position NFT
 * menu open and the wrap confirm sheet. With UX_SHOTS_OUT set the markup is written for
 * scripts/ux-shots/shoot-html.mjs; the assertions run either way.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

vi.mock("@/hooks/useResolvedExit", () => ({ useResolvedExit: () => ({}) }));
vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => ({}) }));
vi.mock("@/hooks/useMintPositionNft", () => ({ useMintPositionNft: () => ({}) }));
vi.mock("@/hooks/useBurnPositionNft", () => ({ useBurnPositionNft: () => ({}) }));
vi.mock("@/hooks/useTransferPositionNft", () => ({ useTransferPositionNft: () => ({}) }));
import { JuniorTrancheActionsView } from "@/components/limits/CreatorLimits";
import { creatorStakeState } from "@/lib/limits/creator-stake";
import { CloseMarketChecklistView } from "@/components/my-markets/CreatorMarketRow";
import { closeMarketChecklist } from "@/lib/close-market-checklist";
import { PositionNftMenuView } from "@/components/trade/PositionNftMenu";

async function snap(name: string, el: Element) {
  const out = process.env.UX_SHOTS_OUT;
  if (!out) return;
  const fs = await import("node:fs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/${name}.html`, el.outerHTML);
}
const C = 1_000_000_000n;
const stake = (o: Partial<Parameters<typeof creatorStakeState>[0]> = {}) =>
  creatorStakeState({ vaultValue: C + 300_000_000n, seniorClaimEff: C, backingCover: C, floorBps: 2_000, lpFlat: true, drawOutstandingAtoms: 0n, impaired: false, ...o });
const props = { decimals: 6, collateralSymbol: "USDC", busy: false, error: null, onDeposit: () => undefined, onWithdraw: () => undefined };

describe("WP-9 screens", () => {
  it("creator stake: withdrawable", async () => {
    const r = render(<JuniorTrancheActionsView {...props} stake={stake()} />);
    expect(r.getByTestId("limits-junior-withdrawable").textContent).toContain("100");
    await snap("stake-withdrawable", r.container.firstElementChild!);
  });
  it("creator stake: draw pending (reason line, Withdraw disabled)", async () => {
    const r = render(<JuniorTrancheActionsView {...props} stake={stake({ drawOutstandingAtoms: 1n })} />);
    expect((r.getByTestId("limits-junior-withdraw") as HTMLButtonElement).disabled).toBe(true);
    await snap("stake-draw-pending", r.container.firstElementChild!);
  });
  it("creator stake: resolved", async () => {
    const r = render(<JuniorTrancheActionsView {...props} stake={null} resolved={{ surplusAtoms: 240_000_000n, waitingUntil: null, onRelease: () => undefined }} />);
    await snap("stake-resolved", r.container.firstElementChild!);
  });
  it("close market checklist (fees unclaimed)", async () => {
    const r = render(
      <div className="p-3">
        <button type="button" disabled className="text-[10px] uppercase tracking-[0.1em] text-[var(--short)]/70 disabled:opacity-40">
          close market
        </button>
        <CloseMarketChecklistView checks={closeMarketChecklist({ claimableFeeAtoms: 5n, otherOpenAccounts: 0, insuranceAtoms: 0n })} />
      </div>,
    );
    await snap("close-checklist", r.container.firstElementChild!);
  });
  it("position NFT menu open, then the wrap sheet", async () => {
    const r = render(
      <div className="flex justify-end p-3 pb-40">
        <PositionNftMenuView canWrap isWrapped={false} collateralLabel="120 USDC" busy={null} error={null} onWrap={() => undefined} onSend={() => undefined} onUnwrap={() => undefined} />
      </div>,
    );
    fireEvent.click(r.getByTestId("position-nft-menu-button"));
    await snap("nft-menu", r.container.firstElementChild!);
    fireEvent.click(r.getByTestId("position-nft-wrap"));
    expect(r.getByTestId("position-nft-wrap-sheet")).toBeTruthy();
    await snap("nft-wrap-sheet", r.getByTestId("position-nft-wrap-sheet"));
  });
});
