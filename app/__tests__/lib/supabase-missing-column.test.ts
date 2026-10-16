/**
 * GH#2408: the network-column fallback must fire only when the column is
 * really missing, never on a transient error whose text says "network".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isMissingColumnError } from "@/lib/supabase-missing-column";

describe("isMissingColumnError", () => {
  it("matches Postgres undefined_column naming the column", () => {
    expect(isMissingColumnError({ code: "42703", message: "column trades.network does not exist" }, "network")).toBe(true);
    expect(isMissingColumnError({ code: "42703", message: 'column "network" does not exist' }, "network")).toBe(true);
  });

  it("matches the PostgREST schema-cache miss", () => {
    expect(
      isMissingColumnError({ code: "PGRST204", message: "Could not find the 'network' column of 'trades' in the schema cache" }, "network"),
    ).toBe(true);
  });

  it("ignores transient errors that mention the network", () => {
    expect(isMissingColumnError({ message: "TypeError: NetworkError when attempting to fetch resource" }, "network")).toBe(false);
    expect(isMissingColumnError({ message: "network timeout at: https://x.supabase.co" }, "network")).toBe(false);
    expect(isMissingColumnError({ code: "57014", message: "canceling statement due to statement timeout (network)" }, "network")).toBe(false);
  });

  it("ignores a missing column with a different name", () => {
    expect(isMissingColumnError({ code: "42703", message: "column trades.network_id does not exist" }, "network")).toBe(false);
    expect(isMissingColumnError({ code: "42703", message: "column markets_with_stats.indexer_excluded does not exist" }, "network")).toBe(false);
  });

  it("is false for no error", () => {
    expect(isMissingColumnError(null, "network")).toBe(false);
    expect(isMissingColumnError(undefined, "network")).toBe(false);
  });
});

// Route level: a transient error must surface as an error, not as an
// unfiltered (all-cluster) query.
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  not: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => mockSupabase,
}));

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("GH#2408: /api/trader/:wallet/stats network fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    mockSupabase.from.mockReturnThis();
    mockSupabase.select.mockReturnThis();
    mockSupabase.eq.mockReturnThis();
    mockSupabase.not.mockReturnThis();
    mockSupabase.order.mockReturnThis();
    mockSupabase.limit.mockReset();
  });

  async function call() {
    const { GET } = await import("@/app/api/trader/[wallet]/stats/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost/api/trader/${WALLET}/stats`, {
      headers: { "x-forwarded-for": `9.9.9.${Math.floor(Math.random() * 200) + 1}` },
    });
    return GET(req, { params: Promise.resolve({ wallet: WALLET }) });
  }

  it("does not retry without the network filter on a transient error", async () => {
    mockSupabase.limit.mockResolvedValueOnce({ data: null, error: { message: "network timeout" } });
    mockSupabase.limit.mockResolvedValueOnce({
      data: [{ side: "long", size: "1", price: "1", fee: "0", slab_address: "MAINNET", created_at: new Date().toISOString() }],
      error: null,
    });
    const res = await call();
    // Only the filtered query ran.
    expect(mockSupabase.limit).toHaveBeenCalledTimes(1);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toContain("MAINNET");
  });

  it("still retries when the network column is really missing", async () => {
    mockSupabase.limit.mockResolvedValueOnce({ data: null, error: { code: "42703", message: "column trades.network does not exist" } });
    mockSupabase.limit.mockResolvedValueOnce({ data: [], error: null });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockSupabase.limit).toHaveBeenCalledTimes(2);
  });
});
