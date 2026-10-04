/**
 * The position NFT ⋯ menu and its Wrap confirm sheet responded only to the mouse: Escape did
 * nothing, focus stayed on ⋯ when the menu opened (Tab wandered into the page), and nothing put
 * it back. The menu now handles Escape and focus; the sheet uses the shared Modal.
 */
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => ({}) }));
vi.mock("@/hooks/useMintPositionNft", () => ({ useMintPositionNft: () => ({}) }));
vi.mock("@/hooks/useBurnPositionNft", () => ({ useBurnPositionNft: () => ({}) }));
vi.mock("@/hooks/useTransferPositionNft", () => ({ useTransferPositionNft: () => ({}) }));
import { PositionNftMenuView } from "@/components/trade/PositionNftMenu";

const base = { canWrap: true, isWrapped: false, collateralLabel: "120 USDC", busy: null, error: null, onWrap: vi.fn(), onSend: vi.fn(), onUnwrap: vi.fn() };

describe("Position NFT menu keyboard", () => {
  it("opening focuses the first item; Escape closes and returns focus to ⋯", () => {
    render(<PositionNftMenuView {...base} />);
    const trigger = screen.getByTestId("position-nft-menu-button");
    fireEvent.click(trigger);
    expect(screen.getByTestId("position-nft-wrap")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("Escape closes the Wrap sheet without wrapping", () => {
    const onWrap = vi.fn();
    render(<PositionNftMenuView {...base} onWrap={onWrap} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    fireEvent.click(screen.getByTestId("position-nft-wrap"));
    expect(screen.getByTestId("position-nft-wrap-sheet")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("position-nft-wrap-sheet")).toBeNull();
    expect(onWrap).not.toHaveBeenCalled();
    // Focus goes back to ⋯, not to the top of the page.
    expect(screen.getByTestId("position-nft-menu-button")).toHaveFocus();
  });

  it("focus leaving the menu closes it", () => {
    render(
      <>
        <PositionNftMenuView {...base} />
        <button>elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    fireEvent.blur(screen.getByTestId("position-nft-wrap"), { relatedTarget: elsewhere });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the Wrap sheet moves focus inside it", () => {
    render(<PositionNftMenuView {...base} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    fireEvent.click(screen.getByTestId("position-nft-wrap"));
    expect(screen.getByTestId("position-nft-wrap-sheet").contains(document.activeElement)).toBe(true);
  });
});
