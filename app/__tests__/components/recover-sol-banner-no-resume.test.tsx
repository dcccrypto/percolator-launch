/**
 * /my-markets mounts RecoverSolBanner with no props
 * (CreatorAttentionStrip.tsx). The status text there says "Resume to finish
 * it", "Continue or Discard" and "retry initialisation", so without onResume
 * the card must still offer that action, as a link to /create where the same
 * card is fully wired. "START NEW" / "START FRESH" must not be promised when
 * there is no onReset to start anything. With every prop passed (/create),
 * nothing may change.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";

let mockSlab: Record<string, unknown> | null = null;
const hooks = vi.hoisted(() => ({ reclaimStatus: "idle", closeLoading: false, clearStuck: vi.fn() }));

beforeEach(() => {
  hooks.reclaimStatus = "idle";
  hooks.closeLoading = false;
  hooks.clearStuck.mockClear();
});

vi.mock("@/hooks/useStuckSlabs", () => ({
  useStuckSlabs: () => ({
    stuckSlab: mockSlab,
    stuckSlabs: mockSlab ? [mockSlab] : [],
    loading: false,
    clearStuck: hooks.clearStuck,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/useCloseMarket", () => ({
  useCloseMarket: () => ({ closeSlab: vi.fn(), loading: hooks.closeLoading, error: null }),
}));
vi.mock("@/hooks/useReclaimSlabRent", () => ({
  useReclaimSlabRent: () => ({
    status: hooks.reclaimStatus,
    error: null,
    txSig: hooks.reclaimStatus === "success" ? "sig" : null,
    reclaim: vi.fn(),
  }),
}));

function makeSlab(overrides: Record<string, unknown>) {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    keypair: kp,
    exists: true,
    isInitialized: true,
    lamports: 2_000_000_000,
    owner: "ProgramId111111111111111111111111111111111",
    lastStep: 1,
    ...overrides,
  };
}

const createLinks = () =>
  screen.queryAllByRole("link").filter((l) => l.getAttribute("href") === "/create");

const STATES = [
  { name: "initialized, still reclaimable (lastStep 1)", slab: { lastStep: 1 }, link: /RESUME ON CREATE PAGE/ },
  { name: "initialized, rent committed (lastStep 4)", slab: { lastStep: 4 }, link: /RESUME ON CREATE PAGE/ },
  { name: "not initialized", slab: { isInitialized: false }, link: /RETRY ON CREATE PAGE/ },
  { name: "not initialized, no saved keypair", slab: { isInitialized: false, keypair: null }, link: /RETRY ON CREATE PAGE/ },
] as const;

describe("RecoverSolBanner without onResume/onReset (/my-markets)", () => {
  beforeEach(() => {
    mockSlab = null;
  });

  for (const s of STATES) {
    it(`${s.name}: links to /create for the action the text names`, () => {
      mockSlab = makeSlab(s.slab);
      render(<RecoverSolBanner />);
      const links = createLinks();
      expect(links).toHaveLength(1);
      expect(links[0].textContent).toMatch(s.link);
      // The in-place buttons stay /create-only.
      expect(screen.queryByRole("button", { name: /RESUME|RETRY/i })).toBeNull();
    });

    it(`${s.name}: discard does not promise to start anything`, () => {
      mockSlab = makeSlab(s.slab);
      render(<RecoverSolBanner />);
      expect(screen.getByRole("button", { name: /DISCARD/i }).textContent).toBe("DISCARD");
    });
  }

  it("after a reclaim, START NEW MARKET leads to /create", () => {
    hooks.reclaimStatus = "success";
    mockSlab = makeSlab({ isInitialized: false });
    render(<RecoverSolBanner />);
    const links = createLinks();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toMatch(/START NEW MARKET/);
    expect(screen.queryByRole("button", { name: /START NEW MARKET/ })).toBeNull();
    localStorage.setItem("percolator-wizard-state", "{}");
    fireEvent.click(links[0]);
    expect(hooks.clearStuck).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("percolator-wizard-state")).toBeNull();
  });

  it("no RETRY link while a rent reclaim is sending", () => {
    hooks.reclaimStatus = "sending";
    mockSlab = makeSlab({ isInitialized: false });
    render(<RecoverSolBanner />);
    expect(createLinks()).toHaveLength(0);
  });

  it("no RESUME link while a close is in flight", () => {
    hooks.closeLoading = true;
    mockSlab = makeSlab({ lastStep: 1 });
    render(<RecoverSolBanner />);
    expect(createLinks()).toHaveLength(0);
  });

  it("rolled back: clear does not promise to start anything", () => {
    mockSlab = makeSlab({ exists: false, lamports: 0 });
    render(<RecoverSolBanner />);
    expect(screen.getByRole("button", { name: /CLEAR/i }).textContent).toBe("CLEAR");
    expect(createLinks()).toHaveLength(0);
  });
});

describe("RecoverSolBanner with every prop (/create) is unchanged", () => {
  const props = { onResume: vi.fn(), onReset: vi.fn(), onReclaimSuccess: vi.fn() };

  it("initialized, still reclaimable: RESUME CREATION button, DISCARD & START NEW, no /create link", () => {
    mockSlab = makeSlab({ lastStep: 1 });
    render(<RecoverSolBanner {...props} />);
    expect(screen.getByRole("button", { name: "RESUME CREATION →" })).toBeDefined();
    expect(screen.getByRole("button", { name: "DISCARD & START NEW" })).toBeDefined();
    expect(createLinks()).toHaveLength(0);
  });

  it("initialized: RESUME CREATION button, DISCARD & START NEW, no /create link", () => {
    mockSlab = makeSlab({ lastStep: 4 });
    render(<RecoverSolBanner {...props} />);
    expect(screen.getByRole("button", { name: "RESUME CREATION →" })).toBeDefined();
    expect(screen.getByRole("button", { name: "DISCARD & START NEW" })).toBeDefined();
    expect(createLinks()).toHaveLength(0);
  });

  it("not initialized: RETRY INITIALIZATION button, DISCARD & START NEW, no /create link", () => {
    mockSlab = makeSlab({ isInitialized: false });
    render(<RecoverSolBanner {...props} />);
    expect(screen.getByRole("button", { name: "RETRY INITIALIZATION →" })).toBeDefined();
    expect(screen.getByRole("button", { name: "DISCARD & START NEW" })).toBeDefined();
    expect(createLinks()).toHaveLength(0);
  });

  it("after a reclaim: START NEW MARKET stays a button", () => {
    hooks.reclaimStatus = "success";
    mockSlab = makeSlab({ isInitialized: false });
    render(<RecoverSolBanner {...props} />);
    expect(screen.getByRole("button", { name: "START NEW MARKET →" })).toBeDefined();
    expect(createLinks()).toHaveLength(0);
  });

  it("rolled back: CLEAR & START FRESH", () => {
    mockSlab = makeSlab({ exists: false, lamports: 0 });
    render(<RecoverSolBanner {...props} />);
    expect(screen.getByRole("button", { name: "CLEAR & START FRESH" })).toBeDefined();
  });
});
