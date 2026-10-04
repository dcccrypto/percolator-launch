/**
 * Follow-ups to #2968 (supersedes it; fixes #2967):
 *  1. START NEW MARKET on /my-markets clears the wizard's saved form under the
 *     SAME key the wizard persists it with (shared WIZARD_STORAGE_KEY), so the
 *     two cannot drift apart.
 *  2. #3041's RESUMING state is a /create-only concept: without onResume a
 *     stray resumingSlab never turns the /create link into a dead "RESUMING…",
 *     and with onResume the wired button still shows it and no link appears.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";
import { WIZARD_STORAGE_KEY } from "@/lib/wizard-storage";

let mockSlab: Record<string, unknown> | null = null;
const hooks = vi.hoisted(() => ({ reclaimStatus: "idle", clearStuck: vi.fn() }));

beforeEach(() => {
  hooks.reclaimStatus = "idle";
  hooks.clearStuck.mockClear();
  mockSlab = null;
  localStorage.clear();
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
  useCloseMarket: () => ({ closeSlab: vi.fn(), loading: false, error: null }),
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

describe("START NEW MARKET link clears the wizard's own storage key", () => {
  it("removes exactly WIZARD_STORAGE_KEY and leaves unrelated keys alone", () => {
    hooks.reclaimStatus = "success";
    mockSlab = makeSlab({ isInitialized: false });
    render(<RecoverSolBanner />);
    localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify({ step: 3 }));
    localStorage.setItem("unrelated-key", "keep");
    fireEvent.click(createLinks()[0]);
    expect(localStorage.getItem(WIZARD_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated-key")).toBe("keep");
    expect(hooks.clearStuck).toHaveBeenCalledTimes(1);
  });

  it("the key literal lives only in lib/wizard-storage (no drifting copies in app code)", () => {
    const root = path.resolve(__dirname, "../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, "utf8").includes('"percolator-wizard-state"')) {
          hits.push(path.relative(root, full));
        }
      }
    };
    for (const d of ["components", "hooks", "lib", "app"]) walk(path.join(root, d));
    expect(hits).toEqual(["lib/wizard-storage.ts"]);
  });
});

describe("#3041 RESUMING state vs the /my-markets mount", () => {
  it("without onResume, a resumingSlab for this card still renders the /create link, never RESUMING…", () => {
    mockSlab = makeSlab({ lastStep: 1 });
    const slab = (mockSlab.publicKey as { toBase58(): string }).toBase58();
    render(<RecoverSolBanner resumingSlab={slab} />);
    expect(createLinks()).toHaveLength(1);
    expect(createLinks()[0].textContent).toMatch(/RESUME ON CREATE PAGE/);
    expect(screen.queryByText(/RESUMING/)).toBeNull();
  });

  it("with onResume and resumingSlab (/create mid-resume): disabled RESUMING… button, no /create link", () => {
    mockSlab = makeSlab({ lastStep: 1 });
    const slab = (mockSlab.publicKey as { toBase58(): string }).toBase58();
    render(<RecoverSolBanner onResume={vi.fn()} onReset={vi.fn()} onReclaimSuccess={vi.fn()} resumingSlab={slab} />);
    const btn = screen.getByRole("button", { name: "RESUMING…" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(createLinks()).toHaveLength(0);
  });

  it("with onResume and resumingSlab=null (/create after CANCEL): RESUME CREATION re-enabled, no /create link", () => {
    mockSlab = makeSlab({ lastStep: 4 });
    render(<RecoverSolBanner onResume={vi.fn()} onReset={vi.fn()} onReclaimSuccess={vi.fn()} resumingSlab={null} />);
    const btn = screen.getByRole("button", { name: "RESUME CREATION →" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(createLinks()).toHaveLength(0);
  });
});
