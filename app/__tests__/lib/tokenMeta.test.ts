import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

// We need to test the module with mocked Connection
// The sanitizeTokenString and other internals are exercised through fetchTokenMeta

// Known PERC mint
const PERC_MINT = "A16Gd8AfaPnG6rohE6iPFDf6mr9gk519d6aMUJAperc";

// Random mint for non-known token paths (uses a real-ish key that produces valid Metaplex PDA)
const RANDOM_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mint

function mockConnection(overrides: {
  rpcEndpoint?: string;
  parsedAccountInfo?: any;
  accountInfo?: any;
  getRecentPrioritizationFees?: any;
} = {}) {
  return {
    rpcEndpoint: overrides.rpcEndpoint ?? "https://api.devnet.solana.com",
    getParsedAccountInfo: vi.fn().mockResolvedValue({
      value: {
        data: {
          parsed: { info: { decimals: overrides.parsedAccountInfo?.decimals ?? 9 } },
        },
      },
    }),
    getAccountInfo: vi.fn().mockResolvedValue(overrides.accountInfo ?? null),
  } as any;
}

describe("fetchTokenMeta", () => {
  let fetchTokenMeta: typeof import("@/lib/tokenMeta").fetchTokenMeta;

  beforeEach(async () => {
    vi.resetModules();
    // Re-import to clear the module-level cache
    const mod = await import("@/lib/tokenMeta");
    fetchTokenMeta = mod.fetchTokenMeta;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns well-known PERC token without RPC lookups for metadata", async () => {
    const conn = mockConnection();
    const result = await fetchTokenMeta(conn, new PublicKey(PERC_MINT));

    expect(result.symbol).toBe("PERC");
    expect(result.name).toBe("Percolator");
    expect(typeof result.decimals).toBe("number");
    // getParsedAccountInfo is still called for decimals
    expect(conn.getParsedAccountInfo).toHaveBeenCalledTimes(1);
  });

  it("caches results for repeated calls", async () => {
    const conn = mockConnection();
    const r1 = await fetchTokenMeta(conn, new PublicKey(PERC_MINT));
    const r2 = await fetchTokenMeta(conn, new PublicKey(PERC_MINT));

    expect(r1).toBe(r2); // Same object reference
    // Only called once due to cache
    expect(conn.getParsedAccountInfo).toHaveBeenCalledTimes(1);
  });

  it("falls back to truncated mint when all lookups fail (non-Helius, no Metaplex)", async () => {
    const conn = mockConnection({ accountInfo: null });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    // Should be truncated mint address, not "Unknown Token"
    expect(result.symbol).toBeTruthy();
    expect(result.name).toBeTruthy();
    expect(result.symbol).not.toBe("Unknown Token");
    expect(result.name).not.toBe("Unknown Token");
    // Truncated form: first 4 + ... + last 4
    expect(result.symbol).toContain("...");
  });

  it("uses Helius DAS when rpcEndpoint contains helius-rpc.com", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            content: { metadata: { symbol: "BONK", name: "Bonk" } },
            token_info: { decimals: 5, symbol: "BONK" },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test123",
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    expect(result.symbol).toBe("BONK");
    expect(result.name).toBe("Bonk");
    expect(result.decimals).toBe(5);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("sanitizes symbol and name — strips unsafe characters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            content: {
              metadata: {
                symbol: '<script>alert("xss")</script>TOKEN',
                name: 'Malicious<img src=x onerror=alert(1)>Name',
              },
            },
            token_info: { decimals: 6 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test",
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    // Should strip angle brackets and other unsafe chars
    expect(result.symbol).not.toContain("<");
    expect(result.symbol).not.toContain(">");
    expect(result.name).not.toContain("<");
    expect(result.name).not.toContain(">");

    vi.unstubAllGlobals();
  });

  it("truncates symbol to 16 chars and name to 32 chars", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            content: {
              metadata: {
                symbol: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                name: "This Is A Very Long Token Name That Should Be Truncated To Thirty Two Chars",
              },
            },
            token_info: { decimals: 6 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test",
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    expect(result.symbol.length).toBeLessThanOrEqual(16);
    expect(result.name.length).toBeLessThanOrEqual(32);

    vi.unstubAllGlobals();
  });

  it("handles Helius DAS returning null gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: null }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test",
      accountInfo: null,
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    // Falls through to Metaplex, then fallback
    expect(result.symbol).toBeTruthy();
    expect(result.decimals).toBe(9);

    vi.unstubAllGlobals();
  });

  it("handles Helius DAS fetch error gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test",
      accountInfo: null,
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    // Should not throw, should fallback
    expect(result.symbol).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("preserves emoji in token names", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            content: { metadata: { symbol: "🐕DOGE", name: "Doge 🚀 Coin" } },
            token_info: { decimals: 8 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test",
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    // Emoji should be preserved per M6 rule
    expect(result.name).toContain("🚀");

    vi.unstubAllGlobals();
  });

  it("handles missing decimals from parsed account info", async () => {
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getParsedAccountInfo: vi.fn().mockResolvedValue({ value: null }),
      getAccountInfo: vi.fn().mockResolvedValue(null),
    } as any;

    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));
    // Should default to 6 decimals
    expect(result.decimals).toBe(6);
  });

  it("uses DAS when rpcEndpoint is the /api/rpc proxy (PERC-198)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            content: { metadata: { symbol: "MATCHA", name: "Matcha" } },
            token_info: { decimals: 6, symbol: "MATCHA" },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const conn = mockConnection({
      rpcEndpoint: "https://percolator.app/api/rpc",
    });
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));

    expect(result.symbol).toBe("MATCHA");
    expect(result.name).toBe("Matcha");
    expect(result.decimals).toBe(6);

    // Verify DAS was called via the proxy
    expect(mockFetch).toHaveBeenCalledWith(
      "https://percolator.app/api/rpc",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("getAsset"),
      }),
    );

    vi.unstubAllGlobals();
  });

  it("handles getParsedAccountInfo throwing without crashing (PERC-198)", async () => {
    vi.resetModules();
    const mod = await import("@/lib/tokenMeta");
    fetchTokenMeta = mod.fetchTokenMeta;

    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getParsedAccountInfo: vi.fn().mockRejectedValue(new Error("rate limited")),
      getAccountInfo: vi.fn().mockResolvedValue(null),
    } as any;

    // Should not throw — gracefully falls back to truncated address
    const result = await fetchTokenMeta(conn, new PublicKey(RANDOM_MINT));
    expect(result.symbol).toBeTruthy();
    expect(result.decimals).toBe(6); // Default when getParsedAccountInfo fails
  });
});
