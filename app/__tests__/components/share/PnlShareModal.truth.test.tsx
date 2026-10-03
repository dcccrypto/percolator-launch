/**
 * Corrections on top of #2907 (credit/2907), against the REAL PnlShareModal +
 * PnlShareCard + lib/pnl-card + hooks/useTokenLogo + lib/capture-node:
 *
 *  a. The card and the tweet always show the TRUE signed PnL/ROE; the label,
 *     wording, arrow and colour follow its sign. (#2907's breakeven clamp held a
 *     LOSS label and printed "+$0.00" over a +$37.50 gain, while the tweet said
 *     "I'm up $37.50".)
 *  b. Logo: logo_url first, then the MAINNET contract address via /api/token-logo.
 *  c. No rocket emoji in the tweet, in any case.
 *  d. Copy image: ClipboardItem built synchronously in the click with a
 *     Promise<Blob> (Safari/iOS), download fallback where unsupported.
 *  f. Pool-capped PnL: the card never shows more than the payable figure.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  priceE6: null as bigint | null,
  subs: new Set<() => void>(),
  capture: null as null | (() => Promise<Blob>),
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  subscribeSlab: (_slab: string, cb: () => void) => {
    h.subs.add(cb);
    return () => h.subs.delete(cb);
  },
  getSnapshot: () => ({ priceUsd: h.priceE6 == null ? null : Number(h.priceE6) / 1e6, priceE6: h.priceE6 }),
}));

// Only the DOM->PNG raster is stubbed (jsdom has no canvas); the clipboard and
// download helpers are the real ones.
vi.mock("@/lib/capture-node", async (io) => {
  const real = await io<typeof import("@/lib/capture-node")>();
  return {
    ...real,
    captureCardToBlob: () => (h.capture ? h.capture() : Promise.resolve(new Blob(["png"], { type: "image/png" }))),
  };
});

import { PnlShareModal } from "@/components/share/PnlShareModal";
import type { PnlCardData } from "@/lib/pnl-card";

// Long 100k units at $1 entry, 10% IM => $10,000 spent.
const DATA: PnlCardData = {
  slab: "Slab1111111111111111111111111111111111111111",
  symbol: "SOL",
  name: "Solana",
  logoUrl: null,
  mainnetCa: null,
  decimals: 6,
  nominalSizeQ: 100_000_000_000n,
  effectiveSizeQ: 100_000_000_000n,
  entryE6: 1_000_000n,
  initialMarginBps: 1000n,
  initialMarkE6: 990_000n, // -$1,000 at open
};

const setMark = (e6: bigint) =>
  act(() => {
    h.priceE6 = e6;
    h.subs.forEach((cb) => cb());
  });

const card = () => ({
  label: screen.getByTestId("pnl-card-label").textContent,
  headline: screen.getByTestId("pnl-card-headline").textContent,
  amount: screen.getByTestId("pnl-card-amount").textContent,
  roe: screen.getByTestId("pnl-card-roe").textContent,
});

let opened: string[] = [];
const tweet = () => {
  opened = [];
  fireEvent.click(screen.getByText("Share to X"));
  const url = new URL(opened[opened.length - 1]);
  return url.searchParams.get("text") ?? "";
};

beforeEach(() => {
  h.priceE6 = null;
  h.subs.clear();
  h.capture = null;
  opened = [];
  vi.spyOn(window, "open").mockImplementation((u?: string | URL) => {
    opened.push(String(u));
    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("a. the card shows the true signed PnL, and the tweet agrees", () => {
  it("#2907 repro: after a held LOSS, a +$37.50 gain reads PROFIT +$37.50 (not LOSS +$0.00), even 60s later", () => {
    vi.useFakeTimers();
    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    expect(card()).toMatchObject({ label: "LOSS", headline: "YOU'RE DOWN", amount: "-$1,000.00" });
    expect(card().roe).toContain("▼");

    setMark(1_000_375n);
    act(() => { vi.advanceTimersByTime(60_000); });

    const c = card();
    expect(c.label).toBe("PROFIT");
    expect(c.headline).toBe("YOU'VE MADE");
    expect(c.amount).toBe("+$37.50");
    expect(c.roe).toContain("▲");
    expect(c.roe).toContain("+0.4%");
    const t = tweet();
    expect(t).toContain("I'm up $37.50 (+0.4%)");
    expect(t).not.toContain("🚀");
  });

  it("the label flips with the sign immediately — no dwell or dead-band on the text", () => {
    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    setMark(1_000_375n);
    expect(card().label).toBe("PROFIT");
    setMark(999_875n);
    expect(card()).toMatchObject({ label: "LOSS", headline: "YOU'RE DOWN", amount: "-$12.50" });
    expect(tweet()).toContain("I'm down $12.50 (-0.1%)");
  });

  it("exactly breakeven: BREAKEVEN $0.00 0.0%, no arrow, and the tweet says breakeven", () => {
    render(<PnlShareModal data={{ ...DATA, initialMarkE6: 1_000_000n }} onClose={() => {}} />);
    const c = card();
    expect(c.label).toBe("BREAKEVEN");
    expect(c.amount).toBe("$0.00");
    expect(c.roe).toBe("0.0%");
    const t = tweet();
    expect(t).toContain("I'm at breakeven ($0.00, 0.0%) on $SOL");
    expect(t).not.toMatch(/up|down/);
  });

  it("for up, down and zero the tweet carries the card's amount and ROE, Devnet V2, and never a rocket", () => {
    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    for (const mark of [1_000_375n, 990_000n, 1_000_000n]) {
      setMark(mark);
      const c = card();
      const t = tweet();
      expect(t).toContain(c.amount!.replace(/^[+-]/, ""));
      expect(t).toContain(c.roe!.replace(/[▲▼]/g, "").trim());
      expect(t).toContain("Percolator Trade Devnet V2");
      expect(t).toContain("sim-USDC");
      expect(t).not.toContain("🚀");
    }
  });
});

describe("b. logo resolution (same precedence as MarketLogo)", () => {
  it("uses logo_url directly and never calls the logo API", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(
      <PnlShareModal data={{ ...DATA, logoUrl: "https://cdn.example/sol.png", mainnetCa: "MainnetCaA111" }} onClose={() => {}} />,
    );
    expect(container.ownerDocument.querySelector('img[src="https://cdn.example/sol.png"]')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without logo_url, resolves from the mainnet CA via /api/token-logo", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ logoUrl: "https://dex.example/b.png" }), { status: 200 }),
    );
    render(<PnlShareModal data={{ ...DATA, mainnetCa: "MainnetCaB222" }} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('img[src="https://dex.example/b.png"]')).not.toBeNull());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/token-logo/MainnetCaB222");
  });

  it("with neither, makes no lookup and shows initials", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("SO")).toBeInTheDocument();
  });
});

describe("d. copy image", () => {
  it("builds the ClipboardItem synchronously in the click, with a Promise<Blob> for image/png", async () => {
    const items: Array<Record<string, unknown>> = [];
    class FakeClipboardItem {
      constructor(data: Record<string, unknown>) { items.push(data); }
    }
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    Object.defineProperty(navigator, "clipboard", { value: { write, writeText: vi.fn() }, configurable: true });
    // A render that never settles proves nothing awaited it before the write.
    h.capture = () => new Promise<Blob>(() => {});

    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Copy image"));

    // Synchronously, still inside the click's user activation:
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0])).toEqual(["image/png"]);
    expect(items[0]["image/png"]).toBeInstanceOf(Promise);
    expect(write).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("falls back to downloading the image where ClipboardItem is unsupported", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const createUrl = vi.fn(() => "blob:fake");
    Object.defineProperty(URL, "createObjectURL", { value: createUrl, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Copy image"));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("image downloaded"));
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("f. pool-capped PnL", () => {
  it("shows the payable figure with a capped note, and the tweet says the same", () => {
    // +$37.50 paper, pool can pay $20.
    render(<PnlShareModal data={{ ...DATA, initialMarkE6: 1_000_375n, payableCapacityAtoms: 20_000_000n }} onClose={() => {}} />);
    const c = card();
    expect(c.label).toBe("PROFIT");
    expect(c.amount).toBe("+$20.00");
    expect(screen.getByTestId("pnl-card-capped")).toHaveTextContent("capped at what the pool can pay · paper +$37.50");
    const t = tweet();
    expect(t).toContain("I'm up $20.00");
    expect(t).toContain("capped at what the pool can pay");
    expect(t).not.toContain("37.50");
  });

  it("does not cap when the pool covers the PnL, or when capacity is unknown", () => {
    render(<PnlShareModal data={{ ...DATA, initialMarkE6: 1_000_375n, payableCapacityAtoms: 1_000_000_000n }} onClose={() => {}} />);
    expect(card().amount).toBe("+$37.50");
    expect(screen.queryByTestId("pnl-card-capped")).toBeNull();
    cleanup();
    render(<PnlShareModal data={{ ...DATA, initialMarkE6: 1_000_375n, payableCapacityAtoms: null }} onClose={() => {}} />);
    expect(card().amount).toBe("+$37.50");
  });
});
