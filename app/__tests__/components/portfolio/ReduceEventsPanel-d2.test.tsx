/** D2 gate: the wallet screen for positions reduced without the trader's order (LP stop included). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReduceEventsState } from "@/hooks/useReduceEvents";
import { REDUCE_NOTICE_COPY } from "@/lib/v22/reduce-copy";

const h = vi.hoisted(() => ({ state: { loading: false, available: true, events: [] } as ReduceEventsState, connected: true }));
vi.mock("@/hooks/useReduceEvents", () => ({ useReduceEvents: () => h.state }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: h.connected ? { toBase58: () => "W" } : null }) }));

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ReduceEventsPanel } from "@/components/portfolio/ReduceEventsPanel";

const M = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const ev = (reason: number, sig: string) => ({
  signature: sig, market: M, portfolio: "P", at: "2026-10-29T10:00:00Z", slot: 1, reason, lpStop: reason === 8,
  title: REDUCE_NOTICE_COPY[reason].title, body: REDUCE_NOTICE_COPY[reason].body, reducedQ: "10", priceE6: "1",
});

afterEach(() => {
  __setDevnetV22ForTest(null);
  h.state = { loading: false, available: true, events: [] };
  h.connected = true;
});

describe("ReduceEventsPanel", () => {
  it("v2.2 off, or no wallet: renders nothing", () => {
    __setDevnetV22ForTest(false);
    const { container } = render(<ReduceEventsPanel />);
    expect(container.innerHTML).toBe("");
    __setDevnetV22ForTest(true);
    h.connected = false;
    const r2 = render(<ReduceEventsPanel />);
    expect(r2.container.innerHTML).toBe("");
  });
  it("lists each event with its plain line, the LP stop marked, a link to the market and to the transaction", () => {
    __setDevnetV22ForTest(true);
    h.state = { loading: false, available: true, events: [ev(8, "sigA"), ev(3, "sigB")] };
    render(<ReduceEventsPanel />);
    const rows = screen.getAllByTestId("reduce-event-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain(REDUCE_NOTICE_COPY[8].body);
    expect(rows[0].querySelector('[data-testid="reduce-event-lp-stop"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-testid="reduce-event-lp-stop"]')).toBeNull();
    expect(rows[1].textContent).toContain(REDUCE_NOTICE_COPY[3].body);
    expect(rows[0].querySelector(`a[href="/trade/${M}"]`)).not.toBeNull();
    expect(rows[0].querySelector('a[href*="sigA"]')).not.toBeNull();
  });
  it("empty and unavailable are different answers", () => {
    __setDevnetV22ForTest(true);
    const r1 = render(<ReduceEventsPanel />);
    expect(r1.getByTestId("reduce-events-empty")).toBeTruthy();
    r1.unmount();
    h.state = { loading: false, available: false, events: [] };
    const r2 = render(<ReduceEventsPanel />);
    expect(r2.getByTestId("reduce-events-unavailable")).toBeTruthy();
    expect(r2.queryByTestId("reduce-events-empty")).toBeNull();
  });
});
