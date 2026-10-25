/**
 * #3637: the never-connected panel on /my-markets. The view renders each phase plainly; the Settle button is the only thing
 * that sends and only once matured; the rent copy follows the cluster; nothing renders off the v2.2 build or for a market
 * whose price advanced. Real bytes: CHILLHOUSE-T with the clock fields patched (see lib/v22/never-connected.test.ts).
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SLAB = "56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y";
const h = vi.hoisted(() => ({
  raw: null as Uint8Array | null,
  slot: null as bigint | null,
  markets: [] as { slab: string; creationSlot: bigint | null; neverPushed: boolean | null }[],
  settle: vi.fn(async () => undefined),
  stale: { busy: false, error: null as string | null, done: null as string | null, waiting: null as string | null },
  wallet: null as unknown,
  lookups: 0,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: unknown }) => children,
  useSlabState: () => ({ raw: h.raw }),
}));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => h.slot }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: h.wallet }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/hooks/useStaleResolve", () => ({ useStaleResolve: () => ({ ...h.stale, settle: h.settle, view: null, resolved: false }) }));
vi.mock("@/hooks/useNeverConnectedMarkets", () => ({
  useNeverConnectedMarkets: () => {
    h.lookups++;
    return { markets: h.markets, loading: false, error: false, refetch: vi.fn() };
  },
}));
const net = vi.hoisted(() => ({ n: "devnet" as "devnet" | "mainnet" }));
vi.mock("@/lib/config", () => ({ getNetwork: () => net.n }));

import { NeverConnectedPanel } from "@/components/my-markets/NeverConnectedPanel";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveMarketGeometry } from "@/lib/v22/sdk/layout";

const CREATED = 1_000_000n;
function market(lastGood: bigint, stale = 18_000n): Uint8Array {
  const m = new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));
  const dv = new DataView(m.buffer);
  dv.setBigUint64(16 + 152, lastGood, true);
  dv.setBigUint64(16 + 136, stale, true);
  const g = resolveMarketGeometry(m, { parser: "t", strictLength: false });
  dv.setBigUint64(g.groupOff + g.layout.group.currentSlot, CREATED, true);
  return m;
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  h.raw = market(CREATED);
  h.slot = CREATED + 6_000n;
  h.markets = [{ slab: SLAB, creationSlot: CREATED, neverPushed: true }];
  h.wallet = new PublicKey("11111111111111111111111111111112");
  h.stale = { busy: false, error: null, done: null, waiting: null };
  h.settle.mockClear();
  h.lookups = 0;
  net.n = "devnet";
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

describe("never-connected panel", () => {
  it("waiting: says the price never connected, shows the countdown, no Settle button yet", () => {
    render(<NeverConnectedPanel />);
    const card = screen.getByTestId("never-connected-card");
    expect(card.getAttribute("data-phase")).toBe("waiting");
    expect(card.textContent).toContain("The price for this market never connected");
    expect(card.textContent).toContain("No price was ever accepted for this market, so it could not trade.");
    expect(screen.getByTestId("never-connected-status").textContent).toContain("about 1 hour 20 minutes");
    expect(screen.queryByTestId("never-connected-settle")).toBeNull();
    expect(card.textContent).not.toMatch(/once it arrives|will arrive|connecting/i);
  });

  it("matured: the Settle button appears and is the only thing that calls the settle flow", () => {
    h.slot = CREATED + 18_000n;
    render(<NeverConnectedPanel />);
    expect(h.settle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("never-connected-settle"));
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("no wallet: no button", () => {
    h.slot = CREATED + 18_000n;
    h.wallet = null;
    render(<NeverConnectedPanel />);
    expect(screen.queryByTestId("never-connected-settle")).toBeNull();
  });

  it("window 0: plain no-permissionless-path line, no countdown, no button, no steps", () => {
    h.raw = market(CREATED, 0n);
    h.slot = CREATED + 10_000_000n;
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-card").getAttribute("data-phase")).toBe("no-path");
    expect(screen.getByTestId("never-connected-status").textContent).toMatch(/no permissionless settle window/);
    expect(screen.queryByTestId("never-connected-settle")).toBeNull();
    expect(screen.queryByTestId("never-connected-steps")).toBeNull();
  });

  it("the money-back steps link the existing flows", () => {
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-step-portfolio").querySelector("a")?.getAttribute("href")).toBe("/portfolio");
    expect(screen.getByTestId("never-connected-step-earn").querySelector("a")?.getAttribute("href")).toBe(`/earn/${SLAB}`);
    expect(screen.getByTestId("never-connected-step-stake").querySelector("a")?.getAttribute("href")).toBe("/stake");
  });

  it("a young market (inside the launch wait) is not called never-connected", () => {
    h.slot = CREATED + 1_000n;
    render(<NeverConnectedPanel />);
    expect(screen.queryByTestId("never-connected-card")).toBeNull();
  });

  it("the generic 'funds are back' line is replaced by one that is true while Earn / stake seeds remain", () => {
    h.slot = CREATED + 18_000n;
    h.stale = { busy: false, error: null, done: "Settled. Your funds are back in your wallet.", waiting: null };
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-done").textContent).toMatch(/Earn or the stake pool is still to be taken out/);
    expect(screen.getByTestId("never-connected-card").textContent).not.toMatch(/funds are back in your wallet\.$/);
  });

  it("the settle note does not claim one approval", () => {
    h.slot = CREATED + 18_000n;
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-card").textContent).not.toMatch(/one approval/i);
  });

  it("devnet: no refund is paid; mainnet: the treasury refunds the locked rent", () => {
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-rent").textContent).toMatch(/no rent refund is paid/);
    expect(screen.getByTestId("never-connected-rent").textContent).not.toMatch(/treasury/i);
    cleanup();
    net.n = "mainnet";
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-rent").textContent).toMatch(/treasury refunds that locked rent/);
    expect(screen.getByTestId("never-connected-rent").textContent).not.toMatch(/no rent refund is paid/);
  });

  it("a market whose price advanced after creation renders nothing", () => {
    h.raw = market(CREATED + 5_000n);
    h.markets = [{ slab: SLAB, creationSlot: CREATED, neverPushed: false }];
    render(<NeverConnectedPanel />);
    expect(screen.queryByTestId("never-connected-card")).toBeNull();
  });

  it("the hook's error and done lines from the settle flow are shown", () => {
    h.slot = CREATED + 18_000n;
    h.stale = { busy: false, error: "Couldn't settle the market.", done: null, waiting: null };
    const { unmount } = render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-error").textContent).toContain("Couldn't settle");
    unmount();
    h.stale = { busy: false, error: null, done: "Settled.", waiting: null };
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-done").textContent).toBe("Settled.");
    expect(screen.queryByTestId("never-connected-settle")).toBeNull();
  });

  it("off the v2.2 build: renders nothing and runs no lookup", () => {
    __setDevnetV22ForTest(false);
    const { container } = render(<NeverConnectedPanel />);
    expect(container.innerHTML).toBe("");
    expect(h.lookups).toBe(0);
  });

  it("a final refusal recorded on this device (#3676) classifies a market whose history could not be read", () => {
    h.markets = [{ slab: SLAB, creationSlot: null, neverPushed: null }];
    h.slot = CREATED + 9_000n; // half the window: stale enough for a refusal alone to count
    render(<NeverConnectedPanel />);
    expect(screen.queryByTestId("never-connected-card")).toBeNull(); // no refusal: nothing claimed
    cleanup();
    window.localStorage.setItem(`perc.keeperRegistered.${SLAB}`, "refused");
    render(<NeverConnectedPanel />);
    expect(screen.getByTestId("never-connected-lead").textContent).toMatch(/refused, and the price history could not be read/);
    window.localStorage.removeItem(`perc.keeperRegistered.${SLAB}`);
  });

  it("no on-chain finds: nothing", () => {
    h.markets = [];
    const { container } = render(<NeverConnectedPanel />);
    expect(container.innerHTML).toBe("");
  });
});
