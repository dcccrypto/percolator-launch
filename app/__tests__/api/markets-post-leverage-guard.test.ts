// @vitest-environment node
/**
 * GH#1398 — POST /api/markets max_leverage guard
 *
 * Covers:
 * - max_leverage > 100x is rejected with 400
 * - max_leverage exactly 100x is allowed past the guard (proceeds to on-chain check)
 * - max_leverage null/undefined is allowed past the guard
 * - CRJH9Gtk7qQDdjzDufnAZdfa7AHisfvxCmVVvzpzQN9v is in BLOCKED_SLAB_ADDRESSES
 *
 * Note: the route proceeds to on-chain verification after the leverage guard,
 * which we expect to fail with 400 ("Failed to verify slab on-chain") since
 * there is no real RPC in the test environment. We only test the guard fires
 * BEFORE reaching the RPC call, and that the RPC path IS reached for requests
 * that pass the guard (verified via getAccountInfo spy).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    network: "devnet",
    programId: "11111111111111111111111111111111",
  }),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
  select: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
};

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => mockSupabase,
}));

// Mock @solana/web3.js Connection so on-chain checks fail predictably.
// getAccountInfo rejects with a mock RPC error so the route returns
// "Failed to verify slab on-chain" — proving the RPC path was reached.
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: vi.fn().mockRejectedValue(new Error("mock RPC error")),
    })),
  };
});

// ── helpers ───────────────────────────────────────────────────────────────

// PERC-8332: inject bypass header so the leverage-guard tests reach the leverage
// check without needing a real nonce+signature. This simulates an internal
// migration script that already has the bypass secret configured.
const BYPASS_SECRET = "test-bypass-secret";
process.env.MARKETS_AUTH_BYPASS_SECRET = BYPASS_SECRET;
process.env.MARKETS_AUTH_BYPASS_ENABLED = "true";

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/markets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-markets-bypass": BYPASS_SECRET,
    },
    body: JSON.stringify(body),
  });
}

// Use well-known devnet addresses as test fixtures — all valid base58/Solana public keys.
// (The old fixtures used strings containing 'l' which is not in the base58 alphabet,
// causing new PublicKey(...) to throw before the mocked RPC was ever reached.
// See CodeRabbit finding on PR #1401.)
const VALID_BASE = {
  slab_address: "GRMMNsNPM1GbgxFh3S34f3jvUX6jPbPiH3oxopnDFiWM",
  mint_address: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs",
  deployer: "DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N",
};

// ── tests ─────────────────────────────────────────────────────────────────

describe("POST /api/markets — max_leverage guard (GH#1398)", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/api/markets/route");
    POST = mod.POST as unknown as (req: Request) => Promise<Response>;
  });

  it("rejects max_leverage = 333 with 400", async () => {
    const res = await POST(buildRequest({ ...VALID_BASE, max_leverage: 333 }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/max_leverage exceeds/i);
  });

  it("rejects max_leverage = 101 with 400", async () => {
    const res = await POST(buildRequest({ ...VALID_BASE, max_leverage: 101 }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/max_leverage exceeds/i);
  });

  it("rejects max_leverage = 100.1 with 400", async () => {
    const res = await POST(buildRequest({ ...VALID_BASE, max_leverage: 100.1 }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/max_leverage exceeds/i);
  });

  it("allows max_leverage = 100 (passes guard, hits on-chain check)", async () => {
    const res = await POST(buildRequest({ ...VALID_BASE, max_leverage: 100 }) as never);
    const json = await res.json();
    // Guard must NOT fire
    expect(json.error).not.toMatch(/max_leverage exceeds/i);
    // Route proceeds to on-chain verification — mock RPC returns error proving RPC path was reached
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/failed to verify slab on-chain/i);
  });

  it("allows max_leverage = 10 (passes guard, hits on-chain check)", async () => {
    const res = await POST(buildRequest({ ...VALID_BASE, max_leverage: 10 }) as never);
    const json = await res.json();
    expect(json.error).not.toMatch(/max_leverage exceeds/i);
    expect(json.error).toMatch(/failed to verify slab on-chain/i);
  });

  it("allows missing max_leverage (null/undefined passes guard)", async () => {
    const res = await POST(buildRequest({ ...VALID_BASE }) as never);
    const json = await res.json();
    expect(json.error).not.toMatch(/max_leverage exceeds/i);
    expect(json.error).toMatch(/failed to verify slab on-chain/i);
  });
});

describe("blocklist — GH#1398 garbage markets (system program oracle_authority)", () => {
  const PHANTOM_SLABS = [
    "CRJH9Gtk7qQDdjzDufnAZdfa7AHisfvxCmVVvzpzQN9v", // original (PR #1401)
    // GH#1398 follow-up (PR #1404): remaining 11 phantom oracle_authority = system program slabs
    "J6UU4VHbYXpCAACr5o5xjUVmquagiP2NGbbMp68VUCX9",
    "8L47yqvQRLxZ6PzW3b9jawEM79CmokBvUzeLR7mvtyuU",
    "8kkED3uZznGzSidr8kYJPd3VhzSh7LVngNUx2V1qnW9L",
    "8pKtAV3z6iTKekieF9EenQ4tk1rkAVa9oYsqe7h1PGjx",
    "Eekuz2TgXRPq3rsp5brRW5hofxLdwt6KUXbLUQCKHK9G",
    "Av3zVrW5deLpLo1qZZ7yNJ5Lq5ja4Z9ixijVhV4MuRzE",
    "CrbDmfiooBUTFfGyMhJ1hpToCrBLAXXKySBwEnLHV6kj",
    "FhpPmmuh5UDAjvEjrYBPFwmj4CP4otvsYMxtTb46p1Ss",
    "7xozYEbKhEdjQn5pCAV8bUDQGugZttqZTduPeHkoqRb8",
    "3dp3e288oPjs5w92fg26cVYQMHGuUpsj8YbSFn6wrzp4",
    "8nzjXMvdkC4fRF491QkpKE6aFTLmEcpXEnbh4wQT4iUA",
  ];

  it.each(PHANTOM_SLABS)(
    "%s is in BLOCKED_SLAB_ADDRESSES and isBlockedSlab returns true",
    async (slab) => {
      vi.resetModules();
      const { BLOCKED_SLAB_ADDRESSES, isBlockedSlab } = await import("@/lib/blocklist");
      expect(BLOCKED_SLAB_ADDRESSES.has(slab)).toBe(true);
      expect(isBlockedSlab(slab)).toBe(true);
    }
  );
});
