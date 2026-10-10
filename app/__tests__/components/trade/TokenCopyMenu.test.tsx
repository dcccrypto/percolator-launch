/**
 * Trade header "Copy address" menu (Discord suggestion: a place to copy the CA). The slab address,
 * the token's CA (mainnet contract address) and ticker, and X searches for the CA and $ticker.
 * One button after the market name: "Copy address" from md up, the glyph alone below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TokenCopyMenu } from "@/components/trade/TokenCopyMenu";

const SLAB = "3YcJ8vQe1nWm4tRk7pLs9dXh2fGzBuAy6oNcVjEiYSfw";
const CA = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const writeText = vi.fn(async () => {});
const openWin = vi.fn();

beforeEach(() => {
  writeText.mockClear();
  openWin.mockClear();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  vi.stubGlobal("open", openWin);
});
afterEach(() => vi.unstubAllGlobals());

const renderMenu = (ca: string | null = CA) => render(<TokenCopyMenu slabAddress={SLAB} symbol="cbBTC/USD" mainnetCa={ca} />);
const openMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
  return within(screen.getByRole("menu"));
};

describe("TokenCopyMenu", () => {
  it("lists the slab address, CA and ticker (with their values), then the two X searches", () => {
    renderMenu();
    const items = openMenu().getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Slab address3YcJ…YSfw", "CA7GCi…W2hr", "TickercbBTC", "Search CA on X", "Search $cbBTC on X"]);
  });

  it.each([
    ["Copy Slab address", SLAB, "Slab address copied"],
    ["Copy CA", CA, "CA copied"],
    ["Copy Ticker", "cbBTC", "Ticker copied"],
  ])("%s copies the full value and confirms", async (name, value, note) => {
    renderMenu();
    fireEvent.click(openMenu().getByRole("menuitem", { name }));
    expect(writeText).toHaveBeenCalledWith(value);
    expect((await screen.findByRole("status")).textContent).toBe(note);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("searches the CA, and the ticker as a cashtag, on X in a new tab", () => {
    renderMenu();
    fireEvent.click(openMenu().getByRole("menuitem", { name: "Search CA on X" }));
    expect(openWin).toHaveBeenLastCalledWith(`https://x.com/search?q=${CA}&src=typed_query&f=top`, "_blank", "noopener,noreferrer");
    fireEvent.click(openMenu().getByRole("menuitem", { name: "Search $cbBTC on X" }));
    expect(openWin).toHaveBeenLastCalledWith("https://x.com/search?q=%24cbBTC&src=typed_query&f=top", "_blank", "noopener,noreferrer");
  });

  it("small screens: the words hide, the glyph opens the same menu, so the slab address and the CA are both there", () => {
    renderMenu();
    expect(screen.getByText("Copy address").className).toBe("hidden md:inline");
    const m = openMenu();
    expect(m.getByRole("menuitem", { name: "Copy Slab address" })).toBeTruthy();
    expect(m.getByRole("menuitem", { name: "Copy CA" })).toBeTruthy();
  });

  it("the menu renders outside the header (portaled), so the bar's scroll container can't clip it", () => {
    const { container } = renderMenu();
    openMenu();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("no mainnet token: no CA options; slab and ticker stay", () => {
    renderMenu(null);
    expect(openMenu().getAllByRole("menuitem").map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual([
      "Copy Slab address",
      "Copy Ticker",
      "Search $cbBTC on X",
    ]);
  });

  it("Escape and an outside click close the menu; a click inside it doesn't", () => {
    renderMenu();
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // Unresolved identity: the trade page passes the truncated slab ("3YcJ…YSfw") as the symbol.
  describe("placeholder symbol (identity unresolved)", () => {
    const SHORT = `${SLAB.slice(0, 4)}…${SLAB.slice(-4)}`;
    const renderPlaceholder = (ca: string | null = CA) => render(<TokenCopyMenu slabAddress={SLAB} symbol={SHORT} mainnetCa={ca} />);

    it("offers no Ticker row and no X ticker search, keeps the slab address and CA rows", () => {
      renderPlaceholder();
      const items = openMenu().getAllByRole("menuitem").map((i) => i.textContent);
      expect(items).toEqual(["Slab address3YcJ…YSfw", "CA7GCi…W2hr", "Search CA on X"]);
    });

    it("with no CA either: only the slab address row remains", () => {
      renderPlaceholder(null);
      const items = openMenu().getAllByRole("menuitem").map((i) => i.textContent);
      expect(items).toEqual(["Slab address3YcJ…YSfw"]);
    });

    it("treats an isPlaceholderSymbol-style placeholder (hex / address prefix) the same way", () => {
      render(<TokenCopyMenu slabAddress={SLAB} symbol="3YcJ8vQe" mainnetCa={CA} />);
      expect(openMenu().queryByRole("menuitem", { name: "Copy Ticker" })).toBeNull();
    });

    it("a real ticker still gets both rows", () => {
      renderMenu();
      const menu = openMenu();
      expect(menu.getByRole("menuitem", { name: "Copy Ticker" })).toBeTruthy();
      expect(menu.getByRole("menuitem", { name: /Search \$cbBTC on X/ })).toBeTruthy();
    });
  });
});

