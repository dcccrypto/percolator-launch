/**
 * Round-4 P3 surfaces: the resolved-exit panel (earn-resolved-exit*) and the P3 wizard panel
 * (limits-wizard-junior-*). Pure views over plans / props; no RPC.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ResolvedExitPanelView } from "@/components/limits/ResolvedExitPanel";
import { WizardTranchePanel } from "@/components/limits/CreatorLimits";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { COPY } from "@/lib/limits/copy";
import { ALL_ON } from "../lib/limits/fixtures";
import { creatorStakeState } from "@/lib/limits/creator-stake";

vi.mock("@/hooks/useResolvedExit", () => ({ useResolvedExit: () => ({}) }));

afterEach(() => {
  cleanup();
  __setLimitsFlagsForTest(null);
});

const NOW = new Date("2026-09-30T12:00:00Z");
const view = (p: Partial<Parameters<typeof ResolvedExitPanelView>[0]>) => (
  <ResolvedExitPanelView
    plan={null}
    nowSlot={1_000n}
    estimate={null}
    running={false}
    lastFinish={null}
    error={null}
    canRun
    earnAmount={null}
    canRequest={false}
    onFinish={() => undefined}
    now={NOW}
    locale="en-GB"
    timeZone="UTC"
    {...p}
  />
);
const sweep = { phase: "sweep" as const, steps: [{ kind: "close-resolved" as const, portfolio: "T" }], blockers: [] };
const finishRun = (o: Partial<import("@/lib/limits/resolved-finish").FinishRun> = {}) => ({
  broadcast: 2, skipped: 1, failed: 0, signatures: ["a", "b"], final: { phase: "ready" as const, blockers: [] }, stale: false, requested: false, ...o,
});

/** UX WP-8 (audit §3.9): keeper-first status, a time not a slot, "Finish now" as a secondary link. */
describe("ResolvedExitPanelView (WP-8)", () => {
  it("renders nothing on a live market", () => {
    const { container } = render(view({ plan: { phase: "not-resolved" } }));
    expect(container.innerHTML).toBe("");
  });
  it("settled: calm status + the payout time with the user's amount, no slot number anywhere", () => {
    const { getByTestId, container } = render(
      view({ plan: { phase: "owner-window", untilSlot: 1_000n + 216_000n, steps: [], blockers: [] }, earnAmount: "1,250.00 USDC" }),
    );
    expect(getByTestId("earn-resolved-exit-status").textContent).toBe(COPY.resolvedExit.status);
    const eta = getByTestId("earn-resolved-exit-eta");
    expect(eta.textContent).toMatch(/^Your 1,250.00 USDC will be ready to withdraw by about Thu 1 Oct, 12:10 \(in about 24 hours\)\.$/);
    expect(container.textContent).not.toMatch(/slot|217000|217,000|216000/i);
  });
  it("without an Earn position: the generic line", () => {
    const { getByTestId } = render(view({ plan: sweep }));
    expect(getByTestId("earn-resolved-exit-eta").textContent).toBe(COPY.resolvedExit.eta(null, "Wed 30 Sept, 12:10", "in about 10 minutes"));
  });
  it("Finish now is a secondary LINK (not a primary button) with the step count and fees; clicking runs finish", () => {
    const onFinish = vi.fn();
    const { getByTestId } = render(view({ plan: sweep, estimate: { steps: 3, sol: "0.004" }, onFinish }));
    expect(getByTestId("earn-resolved-exit-finish-explain").textContent).toBe(
      "Anyone can speed this up. Finish the remaining 3 steps now (about 0.004 SOL in network fees).",
    );
    const b = getByTestId("earn-resolved-exit") as HTMLButtonElement;
    expect(b.textContent).toBe(COPY.resolvedExit.finishLink);
    expect(b.className).toContain("underline");
    expect(b.className).not.toMatch(/bg-\[var\(--accent\)\]/);
    fireEvent.click(b);
    expect(onFinish).toHaveBeenCalledWith(false);
  });
  it("with a withdrawable Earn position the link includes the request (one approval)", () => {
    const onFinish = vi.fn();
    const { getByTestId } = render(view({ plan: sweep, estimate: { steps: 1, sol: "0.001" }, canRequest: true, onFinish }));
    const b = getByTestId("earn-resolved-exit");
    expect(b.textContent).toBe(COPY.resolvedExit.finishAndWithdrawLink);
    fireEvent.click(b);
    expect(onFinish).toHaveBeenCalledWith(true);
  });
  it("no runnable steps -> no Finish now; ready -> 'withdraw now', no ETA, no link", () => {
    expect(render(view({ plan: { phase: "owner-window", untilSlot: 9_000n, steps: [], blockers: [] } })).queryByTestId("earn-resolved-exit")).toBeNull();
    cleanup();
    const { getByTestId, queryByTestId } = render(view({ plan: { phase: "ready", blockers: [] }, estimate: { steps: 2, sol: "0.001" } }));
    expect(getByTestId("earn-resolved-exit-status").textContent).toBe(COPY.resolvedExit.ready);
    expect(getByTestId("earn-resolved-exit-panel").dataset.phase).toBe("ready");
    expect(queryByTestId("earn-resolved-exit-eta")).toBeNull();
    expect(queryByTestId("earn-resolved-exit")).toBeNull();
  });
  it("plain blockers (NFT-held, mid-liquidation)", () => {
    const { getAllByTestId } = render(
      view({ plan: { phase: "sweep", steps: [], blockers: [{ kind: "escrowed", portfolio: "N" }, { kind: "escrowed", portfolio: "M" }, { kind: "locked", portfolio: "L" }] } }),
    );
    expect(getAllByTestId("earn-resolved-exit-blocker").map((b) => b.textContent)).toEqual([
      "2 positions are held as NFTs. Their owners need to close them; nothing you can do speeds that up.",
      "1 position is mid-liquidation; it will finish on its own.",
    ]);
  });
  it("result lines: sent, left to the keeper, and the request landing", () => {
    const { getByTestId, rerender } = render(view({ plan: sweep, lastFinish: finishRun({ final: sweep }) }));
    expect(getByTestId("earn-resolved-exit-result").textContent).toBe("Sent 2 steps. The rest will finish automatically.");
    rerender(view({ plan: { phase: "ready", blockers: [] }, lastFinish: finishRun({ requested: true, broadcast: 5 }) }));
    expect(getByTestId("earn-resolved-exit-result").textContent).toBe(`Sent 5 steps. ${COPY.resolvedExit.requested}`);
  });
  it("disabled without a wallet", () => {
    const { getByTestId } = render(view({ canRun: false, plan: sweep, estimate: { steps: 1, sol: "0.001" } }));
    expect((getByTestId("earn-resolved-exit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WizardTranchePanel (P3 wizard)", () => {
  it("floor choices: current one checked, choices above the 2x-seed max disabled, click sets it", () => {
    __setLimitsFlagsForTest(ALL_ON);
    const onFloor = vi.fn();
    const { getAllByTestId, getByTestId } = render(
      <WizardTranchePanel juniorUnits={1000} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" floorBps={2_000} onFloorChange={onFloor} />,
    );
    const btns = getAllByTestId("limits-wizard-junior-floor") as HTMLButtonElement[];
    expect(btns.map((b) => b.dataset.value)).toEqual(["1000", "2000", "3000", "5000"]);
    expect(btns.find((b) => b.getAttribute("aria-checked") === "true")?.dataset.value).toBe("2000");
    expect(btns.every((b) => !b.disabled)).toBe(true); // junior 1000 vs seed NAV 2000 => max 50%
    fireEvent.click(btns[2]);
    expect(onFloor).toHaveBeenCalledWith(3_000);
    expect(getByTestId("limits-wizard-tranche").dataset.floorBps).toBe("2000");
    // UX WP-7 (§4.6): the protocol-set limits in plain words (no "matcher" / "vAMM").
    expect(getByTestId("limits-wizard-pinned-matcher").textContent).toMatch(/^Market limits at launch: up to \$5,000 per trade, \$25,000 total exposure\./);
  });
  it("kill switch: hidden when NEXT_PUBLIC_LIMITS_P3_WIZARD=0", () => {
    __setLimitsFlagsForTest(ALL_ON);
    vi.stubEnv("NEXT_PUBLIC_LIMITS_P3_WIZARD", "0");
    const { container } = render(<WizardTranchePanel juniorUnits={1000} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" />);
    expect(container.innerHTML).toBe("");
    vi.unstubAllEnvs();
  });
  it("shows the requirement issue when the junior is zero", () => {
    __setLimitsFlagsForTest(ALL_ON);
    const { getByTestId } = render(<WizardTranchePanel juniorUnits={0} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" floorBps={1_000} />);
    expect(getByTestId("limits-wizard-junior-issue").dataset.issue).toBe("junior-zero");
  });
});

/** UX WP-9 AC1 (audit §3.10): "Your creator stake", one reason line per fork state. */
describe("Your creator stake (96 / 97)", () => {
  const C0 = 1_000_000_000n;
  const stake = (o: Partial<Parameters<typeof creatorStakeState>[0]> = {}) =>
    creatorStakeState({ vaultValue: C0 + 300_000_000n, seniorClaimEff: C0, backingCover: C0, floorBps: 2_000, lpFlat: true, drawOutstandingAtoms: 0n, impaired: false, ...o });
  const panel = async (props: Record<string, unknown>) => {
    const { JuniorTrancheActionsView } = await import("@/components/limits/CreatorLimits");
    return render(
      <JuniorTrancheActionsView stake={stake()} decimals={6} collateralSymbol="USDC" busy={false} error={null} onDeposit={() => undefined} onWithdraw={() => undefined} {...props} />,
    );
  };
  it("rows: stake value, protects, must keep (with %), withdrawable; Max caps the input", async () => {
    const onWithdraw = vi.fn();
    const onDeposit = vi.fn();
    const { getByTestId, container } = await panel({ onWithdraw, onDeposit });
    const t = container.textContent ?? "";
    expect(t).toContain("Your creator stake");
    expect(t).toContain("First-loss capital backing this market");
    expect(t).toContain("Stake value300 USDC");
    expect(t).toContain("Protects Earn deposits of1000 USDC");
    expect(t).toContain("Must keep at least200 USDC (20% of Earn deposits)");
    expect(getByTestId("limits-junior-withdrawable").textContent).toContain("100 USDC");
    expect(t).not.toMatch(/Cushion|Junior at risk/);
    const wd = getByTestId("limits-junior-withdraw") as HTMLButtonElement;
    fireEvent.change(getByTestId("limits-junior-amount-input"), { target: { value: "250" } });
    expect(wd.disabled).toBe(false);
    fireEvent.click(wd);
    expect(onWithdraw).toHaveBeenCalledWith(100_000_000n); // capped at withdrawable
    fireEvent.click(getByTestId("limits-junior-max"));
    expect((getByTestId("limits-junior-amount-input") as HTMLInputElement).value).toBe("100");
    fireEvent.click(getByTestId("limits-junior-deposit"));
    expect(onDeposit).toHaveBeenCalledWith(100_000_000n);
  });
  for (const [name, o, reason, line] of [
    ["LP has open positions", { lpFlat: false }, "lp-open", "Locked while traders have open positions on your market. It unlocks as they close."],
    ["at the floor", { vaultValue: C0 + 200_000_000n }, "at-floor", "This is the minimum you must keep while Earn deposits are in the vault."],
    ["backing short of C", { backingCover: C0 - 1n }, "backing-short", "Locked until the market's backing covers Earn deposits again."],
    ["draw pending", { drawOutstandingAtoms: 5n }, "draw-pending", "Paused while the market settles a loss. It reopens when that is done."],
  ] as const) {
    it(`fork state "${name}": its reason line, and Withdraw never fires`, async () => {
      const onWithdraw = vi.fn();
      const { getByTestId } = await panel({ stake: stake(o), onWithdraw });
      expect(getByTestId("limits-junior-reason").dataset.reason).toBe(reason);
      expect(getByTestId("limits-junior-reason").textContent).toBe(line);
      fireEvent.change(getByTestId("limits-junior-amount-input"), { target: { value: "1" } });
      const wd = getByTestId("limits-junior-withdraw") as HTMLButtonElement;
      expect(wd.disabled).toBe(true);
      fireEvent.click(wd);
      expect(onWithdraw).not.toHaveBeenCalled();
    });
  }
  it("a 75 refusal from the simulation shows the reason line, not a raw error", async () => {
    const { getByTestId, queryByTestId } = await panel({ stake: stake({ drawOutstandingAtoms: 1n }), refusedReason: "draw-pending", error: "Not withdrawable yet" });
    expect(getByTestId("limits-junior-reason").dataset.reason).toBe("draw-pending");
    expect(queryByTestId("limits-junior-error")).toBeNull();
  });
  it("exhausted", async () => {
    const { getByTestId } = await panel({ stake: stake({ impaired: true }) });
    // One P3 §0.8 wording on every surface (the audit's line would drop the "unless" qualifier).
    expect(getByTestId("limits-creator-impaired").textContent).toBe(COPY.juniorExhausted);
  });
});

describe("Your creator stake: resolved (102)", () => {
  const props = { stake: null, decimals: 6, collateralSymbol: "USDC", busy: false, error: null, onDeposit: () => undefined, onWithdraw: () => undefined };
  it("available: 'Withdraw {x}', releases exactly that; no top-up/withdraw", async () => {
    const { JuniorTrancheActionsView } = await import("@/components/limits/CreatorLimits");
    const onRelease = vi.fn();
    const { getByTestId, queryByTestId } = render(<JuniorTrancheActionsView {...props} resolved={{ surplusAtoms: 2_500_000n, waitingUntil: null, onRelease }} />);
    expect(getByTestId("limits-junior-actions").dataset.mode).toBe("resolved");
    expect(getByTestId("limits-junior-resolved-surplus").textContent).toBe("Your creator stake: 2.5 USDC available after Earn depositors are paid.");
    expect(queryByTestId("limits-junior-deposit")).toBeNull();
    expect(getByTestId("limits-junior-release-resolved").textContent).toBe("Withdraw 2.5 USDC");
    fireEvent.click(getByTestId("limits-junior-release-resolved"));
    expect(onRelease).toHaveBeenCalledWith(2_500_000n);
  });
  it("before the final payouts: when, as a time; no button", async () => {
    const { JuniorTrancheActionsView } = await import("@/components/limits/CreatorLimits");
    const { getByTestId, queryByTestId } = render(<JuniorTrancheActionsView {...props} resolved={{ surplusAtoms: null, waitingUntil: "Thu 1 Oct, 12:10, in about 24 hours", onRelease: () => undefined }} />);
    expect(getByTestId("limits-junior-resolved-surplus").textContent).toBe("Available once the market's final payouts finish (about Thu 1 Oct, 12:10, in about 24 hours).");
    expect(queryByTestId("limits-junior-release-resolved")).toBeNull();
  });
});
