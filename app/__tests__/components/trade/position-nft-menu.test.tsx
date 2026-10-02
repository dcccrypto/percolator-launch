/**
 * UX WP-9 AC6 (audit §3.13, NF-1): the Position NFT panel is gone from the ticket rail; the row's
 * "⋯" menu has Wrap (with a confirm sheet, 1 approval), Send and Unwrap.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => ({}) }));
vi.mock("@/hooks/useMintPositionNft", () => ({ useMintPositionNft: () => ({}) }));
vi.mock("@/hooks/useBurnPositionNft", () => ({ useBurnPositionNft: () => ({}) }));
vi.mock("@/hooks/useTransferPositionNft", () => ({ useTransferPositionNft: () => ({}) }));
import { NFT_MENU_COPY, PositionNftMenuView } from "@/components/trade/PositionNftMenu";
import { sendNftCopy } from "@/components/trade/SendPositionNftModal";

const base = { canWrap: false, isWrapped: false, collateralLabel: "120 USDC", busy: null, error: null, onWrap: () => undefined, onSend: () => undefined, onUnwrap: () => undefined };

describe("ticket rail", () => {
  it("no PositionNftPanel in the trade page, and the component is gone", () => {
    const page = readFileSync(resolve(process.cwd(), "app/trade/[slab]/page.tsx"), "utf8");
    expect(page).not.toMatch(/<PositionNftPanel|import \{ PositionNftPanel \}/);
    expect(existsSync(resolve(process.cwd(), "components/trade/PositionNftPanel.tsx"))).toBe(false);
  });
});

describe("PositionNftMenuView", () => {
  it("nothing to act on -> no menu", () => {
    const { container } = render(<PositionNftMenuView {...base} />);
    expect(container.innerHTML).toBe("");
  });
  it("own unwrapped position: Wrap opens the confirm sheet; confirm wraps once", () => {
    const onWrap = vi.fn();
    const { container, getByTestId, queryByTestId } = render(<PositionNftMenuView {...base} canWrap onWrap={onWrap} />);
    fireEvent.click(getByTestId("position-nft-menu-button"));
    expect(queryByTestId("position-nft-send")).toBeNull();
    fireEvent.click(getByTestId("position-nft-wrap"));
    const sheet = getByTestId("position-nft-wrap-sheet");
    // Portaled to <body>: inline, the trade page's animate-fade-in root capped its z-index under
    // the mobile tab bar, which covered Cancel / Wrap.
    expect(container.contains(sheet)).toBe(false);
    expect(sheet.parentElement).toBe(document.body);
    expect(sheet.textContent).toContain(NFT_MENU_COPY.wrapTitle);
    expect(sheet.textContent).toContain(
      "Your whole trading account on this market (the position and all 120 USDC of its collateral) moves into the NFT. Whoever holds the NFT controls it. Unwrap any time to get it back.",
    );
    expect(onWrap).not.toHaveBeenCalled();
    fireEvent.click(getByTestId("position-nft-wrap-confirm"));
    expect(onWrap).toHaveBeenCalledTimes(1);
    expect(queryByTestId("position-nft-wrap-sheet")).toBeNull();
  });
  it("wrapped: Send and Unwrap, no Wrap", () => {
    const onSend = vi.fn();
    const onUnwrap = vi.fn();
    const { getByTestId, queryByTestId } = render(<PositionNftMenuView {...base} isWrapped onSend={onSend} onUnwrap={onUnwrap} />);
    fireEvent.click(getByTestId("position-nft-menu-button"));
    expect(queryByTestId("position-nft-wrap")).toBeNull();
    fireEvent.click(getByTestId("position-nft-send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("position-nft-menu-button"));
    fireEvent.click(getByTestId("position-nft-unwrap"));
    expect(onUnwrap).toHaveBeenCalledTimes(1);
  });
  it("send copy is plain", () => {
    expect(sendNftCopy("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe(
      "Send this position to 9xQe…VFin. They'll control the position and its collateral. You can't undo this.",
    );
  });
});
