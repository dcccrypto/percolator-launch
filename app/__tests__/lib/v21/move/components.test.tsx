import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MovePlanView } from "@/components/move/MovePlanView";
import { V1CloseOnlyBadge, V1CloseOnlyBanner } from "@/components/move/V1CloseOnlyNotice";
import { buildMovePlan, summarizePlan } from "@/lib/v21/move/plan";
import { stepHref } from "@/hooks/useMoveFlow";
import { input, market, SOL_SLAB, V21_SOL_SLAB } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
afterEach(cleanup);

describe("MovePlanView", () => {
  it("shows each step with its status, a countdown for a waiting withdrawal, and a link only for ready steps", () => {
    const plan = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: true }, earn: { shares: 0n, pending: { shares: 1n, unlockSlot: 9_000n }, requestsPaused: false } })]));
    render(<MovePlanView plan={plan} summary={summarizePlan(plan)} v21Live running={false} hrefFor={(s) => stepHref(s.kind, s.slab, V21_SOL_SLAB)} onRun={() => {}} onRescan={() => {}} />);
    expect(screen.getByTestId("move-step-close")).toHaveAttribute("data-status", "ready");
    expect(screen.getByTestId("move-open-close")).toHaveAttribute("href", `/trade/${SOL_SLAB}`);
    expect(screen.getByTestId("move-step-withdraw")).toHaveAttribute("data-status", "blocked");
    expect(screen.queryByTestId("move-open-withdraw")).toBeNull();
    expect(screen.getByTestId("move-step-earn-execute")).toHaveAttribute("data-status", "waiting");
    expect(screen.getByTestId("move-countdown")).toHaveTextContent(/remaining/);
    expect(screen.queryByTestId("move-open-earn-execute")).toBeNull();
  });
  it("in-place steps get a Do it button that runs just that step; deposits stay links; the last error shows", () => {
    const plan = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]));
    const onRunStep = vi.fn();
    render(<MovePlanView plan={plan} summary={summarizePlan(plan)} v21Live running={false} hrefFor={() => "/x"} onRun={() => {}} onRunStep={onRunStep} error="Nothing was sent." onRescan={() => {}} />);
    screen.getByTestId("move-do-close").click();
    expect(onRunStep).toHaveBeenCalledWith(expect.objectContaining({ kind: "close", slab: SOL_SLAB }));
    expect(screen.queryByTestId("move-open-close")).toBeNull();
    expect(screen.getByTestId("move-run-error")).toHaveTextContent("Nothing was sent.");
  });
  it("a running run disables the step button", () => {
    const plan = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]));
    render(<MovePlanView plan={plan} summary={summarizePlan(plan)} v21Live running hrefFor={() => "/x"} onRun={() => {}} onRunStep={() => {}} onRescan={() => {}} />);
    expect(screen.getByTestId("move-do-close")).toBeDisabled();
  });
  it("says v2.1 is not open yet when it is not live", () => {
    const plan = buildMovePlan(input([market()], { v21Live: false }));
    render(<MovePlanView plan={plan} summary={summarizePlan(plan)} v21Live={false} running={false} hrefFor={() => "/"} onRun={() => {}} onRescan={() => {}} />);
    expect(screen.getByTestId("move-not-live")).toBeInTheDocument();
  });
  it("deposit links go to the v2.1 market, v1 steps to the v1 market", () => {
    expect(stepHref("deposit-market", SOL_SLAB, V21_SOL_SLAB)).toBe(`/trade/${V21_SOL_SLAB}`);
    expect(stepHref("deposit-earn", SOL_SLAB, V21_SOL_SLAB)).toBe(`/earn/${V21_SOL_SLAB}`);
    expect(stepHref("earn-request", SOL_SLAB, V21_SOL_SLAB)).toBe(`/earn/${SOL_SLAB}`);
    expect(stepHref("withdraw", SOL_SLAB, V21_SOL_SLAB)).toBe(`/trade/${SOL_SLAB}`);
  });
});

describe("v1 close-only notice", () => {
  it("badge reads 'v1 · close-only'; banner promises exits and links to /move", () => {
    render(<><V1CloseOnlyBadge /><V1CloseOnlyBanner /></>);
    expect(screen.getByTestId("v1-close-only-badge")).toHaveTextContent("v1 · close-only");
    expect(screen.getByTestId("v1-close-only-banner")).toHaveTextContent(/close positions, withdraw, collect Earn withdrawals and claim fees/);
    expect(screen.getByTestId("v1-move-link")).toHaveAttribute("href", "/move");
  });
});
