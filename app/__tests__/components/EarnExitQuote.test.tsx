import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EarnExitQuote } from "@/components/earn/EarnExitQuote";
import type { EarnExitState } from "@/hooks/useEarnExitV22";
import type { ExitQuote } from "@/lib/v22/earn-exit-run";

const quote = (over: Partial<ExitQuote> = {}): ExitQuote => ({
  mode: "pair", quote: 1_000_000n, minPayout: 999_500n, staleCount: 0, refreshSelected: 0, refreshDeferred: 0, computeUnits: 400_000, estimate: false, ...over,
});
const st = (over: Partial<EarnExitState>): EarnExitState => ({ phase: "idle", quote: null, requoted: false, message: null, signature: null, ...over });
const mk = (state: EarnExitState) => {
  const getQuote = vi.fn();
  const confirm = vi.fn();
  render(<EarnExitQuote exit={{ state, getQuote, confirm }} decimals={6} symbol="USDC" canQuote />);
  return { getQuote, confirm };
};

describe("EarnExitQuote", () => {
  it("before a quote there is no sign button, only 'See exit price'", () => {
    const { getQuote } = mk(st({}));
    expect(screen.queryByTestId("earn-exit-confirm")).toBeNull();
    fireEvent.click(screen.getByTestId("earn-exit-get-quote"));
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("the quoted minimum is shown before the withdraw button exists, and confirm fires once", () => {
    const { confirm } = mk(st({ phase: "quoted", quote: quote() }));
    expect(screen.getByTestId("earn-exit-min").textContent).toBe("You'll receive at least 0.99 USDC");
    expect(screen.queryByTestId("earn-exit-dip")).toBeNull();
    fireEvent.click(screen.getByTestId("earn-exit-confirm"));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("dip note only when positions are refreshing; re-quote line after a 117", () => {
    mk(st({ phase: "quoted", quote: quote({ staleCount: 2 }), requoted: true }));
    expect(screen.getByTestId("earn-exit-dip")).toBeTruthy();
    expect(screen.getByTestId("earn-exit-requote").textContent).toBe("The exit price moved. Here is the new minimum.");
  });

  it("refreshing shows only the calm line and never a red alert", () => {
    mk(st({ phase: "refreshing" }));
    expect(screen.getByTestId("earn-exit-refreshing").textContent).toBe("Refreshing positions…");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("wait-for-sweep and errors are calm status lines (not variant error)", () => {
    mk(st({ phase: "wait", message: "Positions are refreshing. Try again in a moment." }));
    expect(document.querySelector('[data-variant="error"]')).toBeNull();
  });
});

describe("F9 estimate note", () => {
  it("a request-time floor (estimate) says it is fixed at request; a simulated quote does not", () => {
    mk(st({ phase: "quoted", quote: quote({ estimate: true }) }));
    expect(screen.getByTestId("earn-exit-estimate").textContent).toMatch(/fixed when you request/);
  });
  it("CONTROL: no note on a simulated quote", () => {
    mk(st({ phase: "quoted", quote: quote({ estimate: false }) }));
    expect(screen.queryByTestId("earn-exit-estimate")).toBeNull();
  });
});

describe("N4: an expired quote is a calm line, not an unhandled rejection", () => {
  it("Withdraw on an expired quote shows the line, sends nothing more, and 'See exit price' stays available", async () => {
    const { StaleExitQuoteError } = await import("@/lib/v22/exit-quote-binding");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const getQuote = vi.fn();
    const confirm = vi.fn(async () => {
      throw new StaleExitQuoteError();
    });
    const { rerender } = render(<EarnExitQuote exit={{ state: st({ phase: "quoted", quote: quote() }), getQuote, confirm }} decimals={6} symbol="USDC" canQuote />);
    fireEvent.click(screen.getByTestId("earn-exit-confirm"));
    await new Promise((r) => setTimeout(r, 0));
    // the hook has reset the state to idle by then
    rerender(<EarnExitQuote exit={{ state: st({}), getQuote, confirm }} decimals={6} symbol="USDC" canQuote />);
    expect(screen.getByTestId("earn-exit-expired").textContent).toBe("Your quote expired. See the exit price again.");
    expect(screen.getByTestId("earn-exit-get-quote")).toBeTruthy();
    expect(screen.queryByTestId("earn-exit-confirm")).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });
  it("CONTROL: a confirm that succeeds shows no expiry line", async () => {
    const confirm = vi.fn(async () => undefined);
    mk2(confirm);
    fireEvent.click(screen.getByTestId("earn-exit-confirm"));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("earn-exit-expired")).toBeNull();
  });
});
function mk2(confirm: () => Promise<void>) {
  render(<EarnExitQuote exit={{ state: st({ phase: "quoted", quote: quote() }), getQuote: vi.fn(), confirm }} decimals={6} symbol="USDC" canQuote />);
}
