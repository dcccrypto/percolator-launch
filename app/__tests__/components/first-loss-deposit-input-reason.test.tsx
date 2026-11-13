/**
 * R10 review: the r9 repro for the dead Deposit button is the insurance-staking form (FirstLossDeposit) with "1e3" and the
 * risk box ticked. It showed no reason. It now says why, and Deposit stays off.
 */
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";

const view = vi.hoisted(() => ({ v: { version: 2 } as Record<string, unknown> }));
vi.mock("@/hooks/useStakeFirstLoss", () => ({ useStakeFirstLoss: () => ({}) }));
vi.mock("@/lib/v22/stake-v5", () => ({
  ConsentChangedError: class extends Error {},
  consentKey: () => "k1",
  consentTextMatches: () => true,
  consentViewOf: () => view.v,
  pctOfBps: () => "10%",
}));

import { FirstLossDeposit } from "@/components/stake/FirstLossDeposit";

const state = { pool: {}, deposit: vi.fn(), loading: false, status: "ready", retry: vi.fn() } as unknown as Parameters<typeof FirstLossDeposit>[0]["state"];
const setup = () => {
  render(<FirstLossDeposit slabAddress="s" collateralMint="m" state={state} />);
  fireEvent.click(screen.getByTestId("consent-check"));
};
const type = (v: string) => fireEvent.change(screen.getByTestId("stake-deposit-input"), { target: { value: v } });

describe("FirstLossDeposit amount reason", () => {
  it("'1e3' with the box ticked: Deposit off, and the reason is shown", () => {
    setup();
    type("1e3");
    expect(screen.getByTestId("first-loss-submit")).toBeDisabled();
    expect(screen.getByTestId("stake-deposit-input-error")).toHaveTextContent(/plain number/);
  });
  it("'1,5' and 'abc' reach the reason (a text box, not type=number)", () => {
    setup();
    expect(screen.getByTestId("stake-deposit-input")).toHaveAttribute("type", "text");
    type("1,5");
    expect(screen.getByTestId("stake-deposit-input-error")).toBeInTheDocument();
    type("abc");
    expect(screen.getByTestId("stake-deposit-input-error")).toBeInTheDocument();
  });
  it("CONTROL: a good amount shows no reason and Deposit is on", () => {
    setup();
    type("12.5");
    expect(screen.queryByTestId("stake-deposit-input-error")).toBeNull();
    expect(screen.getByTestId("first-loss-submit")).toBeEnabled();
  });
});
