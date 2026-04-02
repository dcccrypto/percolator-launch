/**
 * ProtocolStatsBar — OI calculation tests.
 *
 * GH#1274: $1 price fallback for volume (admin markets counted at face value).
 * GH#1332: No $1 fallback for OI — markets with no valid oracle price report $0 OI.
 *          Phantom OI guard: vault < 1M or total_accounts = 0 → OI = 0.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ProtocolStatsBar } from "@/components/dashboard/ProtocolStatsBar";
import "@testing-library/jest-dom";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockReturns = vi.fn();
const mockNeq = vi.fn(() => ({ returns: mockReturns }));
const mockSelect = vi.fn(() => ({ neq: mockNeq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/blocklist", () => ({
  isBlockedSlab: vi.fn(() => false),
}));

// ── Helper ────────────────────────────────────────────────────────────────────

type MarketRow = {
  slab_address: string;
  symbol: string | null;
  volume_24h: number | null;
  last_price: number | null;
  decimals: number | null;
  total_open_interest: number | null;
  open_interest_long: number | null;
  open_interest_short: number | null;
  vault_balance: number | null;
  total_accounts: number | null;
};

function makeRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    slab_address: "slab-abc",
    symbol: "TST-PERP",
    volume_24h: null,
    last_price: null,
    decimals: 6,
    total_open_interest: null,
    open_interest_long: null,
    open_interest_short: null,
    // Default: real market with vault + accounts so phantom guard passes
    vault_balance: 1_000_000,
    total_accounts: 2,
    ...overrides,
  };
}

function mockSupabase(rows: MarketRow[]) {
  mockReturns.mockResolvedValue({ data: rows });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProtocolStatsBar — GH#1274 price fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows $0 OI when there are no markets", async () => {
    mockSupabase([]);
    render(<ProtocolStatsBar />);
    await waitFor(() => {
      expect(screen.getByText("Open Interest")).toBeInTheDocument();
      expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    });
  });

  it("GH#1332: shows $0 OI when last_price is null (no $1 fallback for OI)", async () => {
    // GH#1332: Admin-mode markets without a valid oracle price must not contribute
    // to OI (their USD value is indeterminate). Previously the $1 fallback inflated
    // global OI from $64K to $117K.
    const rawOi = 53_800 * 1_000_000;
    mockSupabase([
      makeRow({
        slab_address: "slab-admin-1",
        last_price: null,  // no oracle price → OI = $0
        total_open_interest: rawOi,
        decimals: 6,
        vault_balance: 5_000_000,
        total_accounts: 3,
      }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      // No valid price → OI should be $0 (not $53.8K)
      expect(screen.queryByText("$53.8K")).not.toBeInTheDocument();
      expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    });
  });

  it("shows correct OI when last_price is provided", async () => {
    // 1000 tokens at $2 each = $2000 OI; raw = 1000 × 10^6
    const rawOi = 1000 * 1_000_000;
    mockSupabase([
      makeRow({
        slab_address: "slab-oracle-1",
        last_price: 2.0,
        total_open_interest: rawOi,
        decimals: 6,
        vault_balance: 1_000_000,
        total_accounts: 2,
      }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("$2.0K")).toBeInTheDocument();
    });
  });

  it("GH#1332: OI is $0 when raw OI is sane but last_price is null", async () => {
    // GH#1332 regression: even with sane raw OI, if price is unknown the USD value
    // is indeterminate — should NOT use $1 fallback.
    const rawOi = 100_000 * 1_000_000;
    mockSupabase([
      makeRow({
        slab_address: "slab-no-price",
        last_price: null,
        total_open_interest: rawOi,
        decimals: 6,
        vault_balance: 2_000_000,
        total_accounts: 1,
      }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      // Should be $0 — no $1 fallback for OI
      expect(screen.queryByText("$100.0K")).not.toBeInTheDocument();
      expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    });
  });

  it("GH#1297: phantom market (total_accounts=0) contributes $0 OI even with valid price", async () => {
    const rawOi = 50_000 * 1_000_000;
    mockSupabase([
      makeRow({
        slab_address: "slab-phantom",
        last_price: 1.0,
        total_open_interest: rawOi,
        decimals: 6,
        vault_balance: 1_000_000,
        total_accounts: 0,  // phantom — no real positions
      }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.queryByText("$50.0K")).not.toBeInTheDocument();
      expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    });
  });

  it("GH#1297: phantom market (vault < 1M) contributes $0 OI", async () => {
    const rawOi = 50_000 * 1_000_000;
    mockSupabase([
      makeRow({
        slab_address: "slab-dust-vault",
        last_price: 1.0,
        total_open_interest: rawOi,
        decimals: 6,
        vault_balance: 999_999,  // strictly < 1M → phantom
        total_accounts: 5,
      }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.queryByText("$50.0K")).not.toBeInTheDocument();
      expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    });
  });

  it("vault=1M (creation-deposit) is NOT phantom — contributes OI correctly", async () => {
    // Strict < 1M guard: vault=1M is NOT phantom (usdEkK5G, MOLTBOT case).
    const rawOi = 1000 * 1_000_000;
    mockSupabase([
      makeRow({
        slab_address: "slab-creation-vault",
        last_price: 3.0,
        total_open_interest: rawOi,
        decimals: 6,
        vault_balance: 1_000_000,  // exactly 1M — NOT phantom
        total_accounts: 1,
      }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("$3.0K")).toBeInTheDocument();
    });
  });

  it("counts active markets with valid price and real vault", async () => {
    const rawOi = 1_000_000 * 1_000_000;
    mockSupabase([
      makeRow({ slab_address: "s1", last_price: 1.0, total_open_interest: rawOi, vault_balance: 2_000_000, total_accounts: 3 }),
      makeRow({ slab_address: "s2", last_price: 1.0, total_open_interest: rawOi, vault_balance: 2_000_000, total_accounts: 3 }),
      makeRow({ slab_address: "s3", last_price: 1.0, total_open_interest: rawOi, vault_balance: 2_000_000, total_accounts: 3 }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("Active Markets")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("ignores blocked slabs", async () => {
    const { isBlockedSlab } = await import("@/lib/blocklist");
    (isBlockedSlab as ReturnType<typeof vi.fn>).mockImplementation(
      (addr: string) => addr === "slab-blocked"
    );

    const rawOi = 50_000 * 1_000_000;
    mockSupabase([
      makeRow({ slab_address: "slab-blocked", last_price: 1.0, total_open_interest: rawOi, vault_balance: 2_000_000, total_accounts: 3 }),
      makeRow({ slab_address: "slab-ok", last_price: 1.0, total_open_interest: rawOi, vault_balance: 2_000_000, total_accounts: 3 }),
    ]);

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      // Only slab-ok counts: 1 active market, $50K OI
      expect(screen.getByText("$50.0K")).toBeInTheDocument();
      expect(screen.getByText("1")).toBeInTheDocument();
    });
  });
});
