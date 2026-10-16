/**
 * Portfolio Overview's trade history (components/dashboard/TradeHistory) after a wallet switch.
 *
 * 1. Its fetch had no request guard, so wallet A's slower response landing after wallet B's
 *    replaced B's history with A's trades (and the same for out-of-order page flips).
 * 2. The page number survived the switch: on page 3 of A's history, B was read at offset 50.
 *    A wallet with fewer trades got an empty page, "No trades yet", and no pager to go back
 *    (Prev/Next only render when total spans more than one page).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WALLET_A = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";
const WALLET_B = "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ";

const h = vi.hoisted(() => ({ wallet: "" }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: h.wallet ? { toBase58: () => h.wallet } : null, connected: !!h.wallet }),
}));

import { TradeHistory } from "@/components/dashboard/TradeHistory";

/** One fill on a market slab whose short form (first 4 … last 4) identifies the row. */
function trade(id: string, slab: string) {
  return {
    id, slab_address: slab, trader: "W", side: "long", size: "1000000", price: 1, fee: 0.01,
    tx_signature: null, created_at: "2026-10-01T00:00:00Z",
  };
}
const SLAB_A = "AaaaQ6oZ1JEnwFXsuS3AqYEYV17Msmd7hv2VUxjLAaaa";
const SLAB_B = "BbbbYb1YUUd6UzcrkiRsqdhrAzagguvrWmRgcBpsBbbb";
const ROW_A = "Aaaa…Aaaa";
const ROW_B = "Bbbb…Bbbb";

type Pending = { url: string; resolve: (body: unknown) => void };
let pending: Pending[];

beforeEach(() => {
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      new Promise<Response>((res) => {
        pending.push({ url, resolve: (body) => res(new Response(JSON.stringify(body))) });
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function settle(p: Pending, body: unknown) {
  await act(async () => {
    p.resolve(body);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Overview trade history across a wallet switch", () => {
  it("a late response for the previous wallet does not replace the new wallet's history", async () => {
    h.wallet = WALLET_A;
    const view = render(<TradeHistory />);
    await act(async () => {});
    const reqA = pending.find((p) => p.url.includes(WALLET_A))!;

    h.wallet = WALLET_B;
    view.rerender(<TradeHistory />);
    await act(async () => {});
    const reqB = pending.find((p) => p.url.includes(WALLET_B))!;

    await settle(reqB, { trades: [trade("b1", SLAB_B)], total: 1 });
    await settle(reqA, { trades: [trade("a1", SLAB_A)], total: 1 });

    expect(screen.getByText(ROW_B)).toBeTruthy();
    expect(screen.queryByText(ROW_A)).toBeNull();
  });

  it("the new wallet starts on its own first page", async () => {
    h.wallet = WALLET_A;
    const view = render(<TradeHistory />);
    await act(async () => {});
    // A has 60 fills: three pages of 25.
    const pageA = (offset: number) => ({ trades: [trade(`a${offset}`, SLAB_A)], total: 60 });
    await settle(pending.at(-1)!, pageA(0));
    fireEvent.click(screen.getByText("Next →"));
    await settle(pending.at(-1)!, pageA(25));
    fireEvent.click(screen.getByText("Next →"));
    await settle(pending.at(-1)!, pageA(50));
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();

    h.wallet = WALLET_B;
    view.rerender(<TradeHistory />);
    await act(async () => {});
    // Answer every read for B the way the API would: B has a single fill, at offset 0.
    for (const p of pending.filter((q) => q.url.includes(WALLET_B))) {
      const offset = Number(new URL(p.url, "http://x").searchParams.get("offset"));
      await settle(p, offset === 0 ? { trades: [trade("b1", SLAB_B)], total: 1 } : { trades: [], total: 1 });
    }

    expect(screen.getByText(ROW_B)).toBeTruthy();
    expect(screen.queryByText("No trades yet")).toBeNull();
  });
});
