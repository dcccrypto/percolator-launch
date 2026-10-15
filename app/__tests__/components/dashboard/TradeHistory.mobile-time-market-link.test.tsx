import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { fillTimeParts } from "@/lib/fill-time";

const WALLET = "DYvC67UeMeKkLiufhHxpAH8eyso3ZmPD3Y2jTo6PXZbf";
const SLAB = "EEEmo3dBS121szmBziftTEoYJWkKUFnusXkB3ZhyqmrN";

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => WALLET } }),
}));
vi.mock("@/hooks/useAllMarketStats", () => ({
  useAllMarketStats: () => ({ statsMap: new Map([[SLAB, { symbol: "BATON" }]]) }),
}));

import { TradeHistory } from "@/components/dashboard/TradeHistory";

describe("fillTimeParts", () => {
  it("gives an English day + short month and a 24-hour time, whatever the phone's locale", () => {
    expect(fillTimeParts("2026-10-05T18:38:00Z", "UTC")).toEqual({ date: "5 Oct", time: "18:38" });
    expect(fillTimeParts("not a date")).toBeNull();
  });
});

describe("dashboard trade history row", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            trades: [{ id: "a", slab_address: SLAB, trader: WALLET, side: "long", size: "1000000", price: 0.0149, fee: 0, tx_signature: null, created_at: "2026-10-05T18:38:00Z" }],
            total: 1,
          }),
        ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("links the market (by symbol) to its trade page and splits the time into two nowrap lines", async () => {
    render(<TradeHistory />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const link = screen.getByRole("link", { name: "BATON" });
    expect(link.getAttribute("href")).toBe(`/trade/${SLAB}`);
    const parts = fillTimeParts("2026-10-05T18:38:00Z")!;
    const date = screen.getByText(parts.date);
    expect(date.className).toContain("whitespace-nowrap");
    expect(screen.getByText(parts.time).className).toContain("whitespace-nowrap");
  });
});
