/**
 * The Funding, Warmup and Insurance explainers: their ✕ close buttons were SVG-only with no name
 * (announced as "button"), none of the dialogs had an accessible name, and the Insurance explainer
 * built its own overlay with no dialog role, focus trap or focus restore. All three are now named
 * dialogs on the shared Modal with a "Close" button.
 */
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FundingExplainerModal } from "@/components/trade/FundingExplainerModal";
import { WarmupExplainerModal } from "@/components/trade/WarmupExplainerModal";
import { InsuranceExplainerModal } from "@/components/market/InsuranceExplainerModal";

const cases = [
  { name: "Understanding Funding Rates", C: FundingExplainerModal },
  { name: "PnL Warmup", C: WarmupExplainerModal },
  { name: "What is the Insurance Fund?", C: InsuranceExplainerModal },
];

describe.each(cases)("$name explainer", ({ name, C }) => {
  afterEach(cleanup);

  it("is a dialog named by its title, with a named close button", () => {
    const onClose = vi.fn();
    render(<C onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus into the dialog and closes on Escape", () => {
    const onClose = vi.fn();
    render(<C onClose={onClose} />);
    expect(screen.getByRole("dialog", { name }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
