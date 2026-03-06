/**
 * Unit tests for the computeAprs helper used by GET /api/stake/pools.
 *
 * We extract the APR logic inline here to avoid importing the Next.js route
 * directly (which requires the full Next.js environment).
 */

const MS_PER_DAY = 86_400_000;

interface InsuranceSnapshotRow {
  slab: string;
  redemption_rate_e6: number;
  created_at: string;
}

/** Inline copy of computeAprs logic — kept in sync with the route. */
function computeAprs(
  slabAddresses: string[],
  snapshots: { earliest7d: InsuranceSnapshotRow[]; earliest30d: InsuranceSnapshotRow[]; latest: InsuranceSnapshotRow[] }
): Record<string, number> {
  if (slabAddresses.length === 0) return {};

  const { earliest7d, earliest30d, latest } = snapshots;

  const earliest7dBySlab = new Map<string, { rate: number; ts: number }>();
  const earliest30dBySlab = new Map<string, { rate: number; ts: number }>();
  const latestBySlab = new Map<string, { rate: number; ts: number }>();

  for (const row of earliest7d) {
    if (!earliest7dBySlab.has(row.slab)) {
      earliest7dBySlab.set(row.slab, { rate: Number(row.redemption_rate_e6), ts: new Date(row.created_at).getTime() });
    }
  }
  for (const row of earliest30d) {
    if (!earliest30dBySlab.has(row.slab)) {
      earliest30dBySlab.set(row.slab, { rate: Number(row.redemption_rate_e6), ts: new Date(row.created_at).getTime() });
    }
  }
  for (const row of latest) {
    if (!latestBySlab.has(row.slab)) {
      latestBySlab.set(row.slab, { rate: Number(row.redemption_rate_e6), ts: new Date(row.created_at).getTime() });
    }
  }

  const result: Record<string, number> = {};
  for (const slab of slabAddresses) {
    const cur = latestBySlab.get(slab);
    if (!cur || cur.rate === 0) { result[slab] = 0; continue; }

    const old = earliest7dBySlab.get(slab) ?? earliest30dBySlab.get(slab);
    if (!old || old.rate === 0) { result[slab] = 0; continue; }

    const elapsed = cur.ts - old.ts;
    if (elapsed < MS_PER_DAY) { result[slab] = 0; continue; }

    const growth = (cur.rate - old.rate) / old.rate;
    const annualized = growth * (365 * MS_PER_DAY) / elapsed;
    // Clamp to 0: negative APR (insurance drawdown) would confuse stakers.
    result[slab] = isFinite(annualized) ? Math.max(0, Math.round(annualized * 10_000) / 100) : 0;
  }
  return result;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ts(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * MS_PER_DAY).toISOString();
}

const SLAB_A = "SlabAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SLAB_B = "SlabBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("computeAprs", () => {
  it("returns empty map for empty input", () => {
    expect(computeAprs([], { earliest7d: [], earliest30d: [], latest: [] })).toEqual({});
  });

  it("returns 0 for slab with no snapshots", () => {
    const result = computeAprs([SLAB_A], { earliest7d: [], earliest30d: [], latest: [] });
    expect(result[SLAB_A]).toBe(0);
  });

  it("returns 0 when elapsed is less than 1 day", () => {
    // oldest snapshot only 12h ago
    const twelveHAgo = new Date(Date.now() - 0.5 * MS_PER_DAY).toISOString();
    const result = computeAprs([SLAB_A], {
      earliest7d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: twelveHAgo }],
      earliest30d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: twelveHAgo }],
      latest: [{ slab: SLAB_A, redemption_rate_e6: 1_005_000, created_at: new Date().toISOString() }],
    });
    expect(result[SLAB_A]).toBe(0);
  });

  it("computes positive APR from 7-day growth", () => {
    // 1% growth over 7 days → annualised ≈ 52.14%
    const sevenDaysAgo = ts(7);
    const result = computeAprs([SLAB_A], {
      earliest7d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: sevenDaysAgo }],
      earliest30d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: sevenDaysAgo }],
      latest: [{ slab: SLAB_A, redemption_rate_e6: 1_010_000, created_at: new Date().toISOString() }],
    });
    // 1% over 7d → (0.01 * 365/7) * 100 ≈ 52.14%
    expect(result[SLAB_A]).toBeGreaterThan(50);
    expect(result[SLAB_A]).toBeLessThan(55);
  });

  it("returns 0 when redemption rate has not grown (no fees earned)", () => {
    const sevenDaysAgo = ts(7);
    const result = computeAprs([SLAB_A], {
      earliest7d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: sevenDaysAgo }],
      earliest30d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: sevenDaysAgo }],
      latest: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: new Date().toISOString() }],
    });
    expect(result[SLAB_A]).toBe(0);
  });

  it("falls back to 30-day window when 7-day has < 1 day of data", () => {
    const thirtyDaysAgo = ts(30);
    // No 7d snapshots → fall back to 30d
    const result = computeAprs([SLAB_A], {
      earliest7d: [],
      earliest30d: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: thirtyDaysAgo }],
      latest: [{ slab: SLAB_A, redemption_rate_e6: 1_030_000, created_at: new Date().toISOString() }],
    });
    // 3% over 30 days → ≈ 36.5% annualised
    expect(result[SLAB_A]).toBeGreaterThan(34);
    expect(result[SLAB_A]).toBeLessThan(39);
  });

  it("handles multiple slabs independently", () => {
    const sevenDaysAgo = ts(7);
    const now = new Date().toISOString();
    const result = computeAprs([SLAB_A, SLAB_B], {
      earliest7d: [
        { slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: sevenDaysAgo },
        { slab: SLAB_B, redemption_rate_e6: 2_000_000, created_at: sevenDaysAgo },
      ],
      earliest30d: [
        { slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: sevenDaysAgo },
        { slab: SLAB_B, redemption_rate_e6: 2_000_000, created_at: sevenDaysAgo },
      ],
      latest: [
        { slab: SLAB_A, redemption_rate_e6: 1_010_000, created_at: now },
        { slab: SLAB_B, redemption_rate_e6: 2_000_000, created_at: now }, // no growth
      ],
    });
    expect(result[SLAB_A]).toBeGreaterThan(0);
    expect(result[SLAB_B]).toBe(0);
  });

  it("clamps negative APR to 0 (insurance drawdown scenario)", () => {
    const sevenDaysAgo = ts(7);
    // Rate decreased: drawdown scenario
    const result = computeAprs([SLAB_A], {
      earliest7d: [{ slab: SLAB_A, redemption_rate_e6: 1_010_000, created_at: sevenDaysAgo }],
      earliest30d: [{ slab: SLAB_A, redemption_rate_e6: 1_010_000, created_at: sevenDaysAgo }],
      latest: [{ slab: SLAB_A, redemption_rate_e6: 1_000_000, created_at: new Date().toISOString() }],
    });
    expect(result[SLAB_A]).toBe(0);
  });

  it("returns 0 for current rate of 0 (no LP activity)", () => {
    const result = computeAprs([SLAB_A], {
      earliest7d: [{ slab: SLAB_A, redemption_rate_e6: 0, created_at: ts(7) }],
      earliest30d: [{ slab: SLAB_A, redemption_rate_e6: 0, created_at: ts(7) }],
      latest: [{ slab: SLAB_A, redemption_rate_e6: 0, created_at: new Date().toISOString() }],
    });
    expect(result[SLAB_A]).toBe(0);
  });
});
