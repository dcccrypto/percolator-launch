/**
 * #2742 (row claim): a claim sent but not confirmed shows its signature as an explorer link.
 * The note renders inside the row's expand <button>, so opening it must not toggle the drawer.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/SlabProvider", () => ({ SlabProvider: ({ children }: { children: unknown }) => children, useSlabState: () => ({}) }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ network: "devnet", explorerUrl: "https://explorer.solana.com" }) }));

import { ClaimPendingNote } from "@/components/my-markets/CreatorMarketRow";

describe("row claim pending note", () => {
  it("opens the tx on the explorer and does not toggle the row", () => {
    const toggle = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<button type="button" onClick={toggle}><ClaimPendingNote signature="5igPending" /></button>);
    expect(screen.getByTestId("creator-row-claim-pending").textContent).toMatch(/^Claim sent, not confirmed yet\./);
    fireEvent.click(screen.getByRole("link", { name: /check on explorer/i }));
    expect(open).toHaveBeenCalledWith("https://explorer.solana.com/tx/5igPending?cluster=devnet", "_blank", "noopener,noreferrer");
    expect(toggle).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
