/**
 * #3601: after the v2.2 bond refusal the error panel's Continue relaunched step by step, which has no bond, so the
 * market went live without it. The panel now offers the two real choices instead: the same launch again (when the
 * refusal can pass, e.g. a single-transaction attempt that failed on an RPC blip) or the launch without the bond.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LaunchProgress } from "@/components/create/LaunchProgress";
import { bondNeedsSingleTxMessage } from "@/lib/v22/launch-wire";

type ProgressState = Parameters<typeof LaunchProgress>[0]["state"];
const refused: ProgressState = { step: 0, loading: false, error: bondNeedsSingleTxMessage, slabAddress: null, txSigs: [], stepLabel: "Create market" };

describe("the bond refusal's error panel", () => {
  it("offers 'Try again' and 'Launch without the bond', and no Continue", () => {
    const onRetry = vi.fn();
    const onTryAgain = vi.fn();
    const onLaunchWithoutBond = vi.fn();
    render(<LaunchProgress state={refused} onReset={vi.fn()} onRetry={onRetry} bondChoice={{ onTryAgain, onLaunchWithoutBond }} />);
    expect(screen.queryByTestId("wizard-retry")).toBeNull();
    fireEvent.click(screen.getByTestId("wizard-bond-try-again"));
    fireEvent.click(screen.getByTestId("wizard-bond-launch-without"));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(onLaunchWithoutBond).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a refusal that can't pass (bundle too large): only 'Launch without the bond'", () => {
    render(<LaunchProgress state={refused} onReset={vi.fn()} onRetry={vi.fn()} bondChoice={{ onLaunchWithoutBond: vi.fn() }} />);
    expect(screen.queryByTestId("wizard-bond-try-again")).toBeNull();
    expect(screen.getByTestId("wizard-bond-launch-without")).toBeTruthy();
  });

  it("CONTROL: any other error keeps Continue", () => {
    render(<LaunchProgress state={{ ...refused, error: "Something else failed." }} onReset={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByTestId("wizard-retry")).toBeTruthy();
    expect(screen.queryByTestId("wizard-bond-launch-without")).toBeNull();
  });
});
