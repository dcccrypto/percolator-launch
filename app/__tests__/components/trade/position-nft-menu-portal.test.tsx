/**
 * The position NFT ⋯ menu was `absolute` inside the dock's overflow-x-auto table wrapper
 * (PositionsDock), so on a one-row table it was clipped and Wrap / Send / Unwrap sat in a tiny
 * nested scroll area. It is now portaled to <body> with fixed positioning, right-aligned to ⋯ and
 * flipped above it when there is no room below.
 */
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => ({}) }));
vi.mock("@/hooks/useMintPositionNft", () => ({ useMintPositionNft: () => ({}) }));
vi.mock("@/hooks/useBurnPositionNft", () => ({ useBurnPositionNft: () => ({}) }));
vi.mock("@/hooks/useTransferPositionNft", () => ({ useTransferPositionNft: () => ({}) }));
import { PositionNftMenuView } from "@/components/trade/PositionNftMenu";

const base = { canWrap: false, isWrapped: true, collateralLabel: "120 USDC", busy: null, error: null, onWrap: vi.fn(), onSend: vi.fn(), onUnwrap: vi.fn() };

/** Puts ⋯ at the given viewport position and gives the menu a 90px height (jsdom has no layout). */
function layout(trigger: { top: number; bottom: number; left: number; right: number }) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ ...trigger, width: 44, height: 44, x: trigger.left, y: trigger.top, toJSON: () => ({}) } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(90);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
}

describe("Position NFT menu: not clipped by the dock", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the menu outside the row (portaled, fixed), so the table wrapper can't clip it", () => {
    render(<PositionNftMenuView {...base} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    const menu = screen.getByRole("menu");
    expect(screen.getByTestId("position-nft-menu").contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveClass("fixed");
  });

  it("opens above ⋯ when there is no room below (the dock sits at the bottom on phones)", () => {
    layout({ top: window.innerHeight - 60, bottom: window.innerHeight - 16, left: 300, right: 344 });
    render(<PositionNftMenuView {...base} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    expect(screen.getByRole("menu").style.top).toBe(`${window.innerHeight - 60 - 4 - 90}px`);
  });

  it("opens below ⋯ when there is room (no needless flip)", () => {
    layout({ top: 100, bottom: 144, left: 300, right: 344 });
    render(<PositionNftMenuView {...base} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    expect(screen.getByRole("menu").style.top).toBe("148px");
  });

  it("focus moving from ⋯ into the portaled menu doesn't close it", () => {
    render(<PositionNftMenuView {...base} />);
    const trigger = screen.getByTestId("position-nft-menu-button");
    fireEvent.click(trigger);
    fireEvent.blur(trigger, { relatedTarget: screen.getByTestId("position-nft-send") });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("Tab past either end of the menu closes it and returns focus to ⋯, not the end of the page", () => {
    render(<PositionNftMenuView {...base} />);
    const trigger = screen.getByTestId("position-nft-menu-button");
    fireEvent.click(trigger);
    expect(screen.getByTestId("position-nft-send")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    screen.getByTestId("position-nft-unwrap").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("Tab between items keeps the menu open", () => {
    render(<PositionNftMenuView {...base} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    fireEvent.keyDown(document, { key: "Tab" }); // from Send (first), not the last item
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("pressing an item doesn't count as an outside click: the item's action runs", () => {
    const onUnwrap = vi.fn();
    render(<PositionNftMenuView {...base} onUnwrap={onUnwrap} />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    const unwrap = screen.getByTestId("position-nft-unwrap");
    fireEvent.mouseDown(unwrap);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(unwrap);
    expect(onUnwrap).toHaveBeenCalledOnce();
  });
});
