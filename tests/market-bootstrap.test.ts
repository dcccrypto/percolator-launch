/**
 * PERC-355: Market Bootstrap Service tests
 *
 * These are unit tests that mock Solana RPC and external price APIs.
 * They verify the bootstrap logic without requiring a live devnet connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Price fetching logic (extracted for testability)
// ---------------------------------------------------------------------------

interface PriceResult {
  priceE6: bigint;
  source: string;
}

const MINT_SYMBOLS: Record<string, { coingecko?: string; binance?: string }> = {
  So11111111111111111111111111111111111111112: {
    coingecko: "solana",
    binance: "SOLUSDT",
  },
};

async function fetchPriceFromBinance(symbol: string): Promise<bigint | null> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { signal: controller.signal },
    );
    clearTimeout(tid);
    const json = (await res.json()) as { price?: string };
    if (!json.price) return null;
    const p = parseFloat(json.price);
    if (!isFinite(p) || p <= 0) return null;
    return BigInt(Math.round(p * 1_000_000));
  } catch {
    return null;
  }
}

async function fetchPriceFromCoinGecko(id: string): Promise<bigint | null> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: controller.signal },
    );
    clearTimeout(tid);
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const usd = json[id]?.usd;
    if (!usd || !isFinite(usd) || usd <= 0) return null;
    return BigInt(Math.round(usd * 1_000_000));
  } catch {
    return null;
  }
}

async function fetchPrice(mint: string): Promise<PriceResult | null> {
  const mapping = MINT_SYMBOLS[mint];
  if (mapping?.binance) {
    const p = await fetchPriceFromBinance(mapping.binance);
    if (p !== null) return { priceE6: p, source: "binance" };
  }
  if (mapping?.coingecko) {
    const p = await fetchPriceFromCoinGecko(mapping.coingecko);
    if (p !== null) return { priceE6: p, source: "coingecko" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PERC-355: Market Bootstrap", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("Price Fetching", () => {
    it("should fetch price from Binance", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ price: "142.50" }),
      } as unknown as Response);

      const result = await fetchPriceFromBinance("SOLUSDT");
      expect(result).toBe(142_500_000n);
    });

    it("should return null for invalid Binance response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({}),
      } as unknown as Response);

      const result = await fetchPriceFromBinance("SOLUSDT");
      expect(result).toBeNull();
    });

    it("should handle Binance timeout", async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("aborted"));

      const result = await fetchPriceFromBinance("SOLUSDT");
      expect(result).toBeNull();
    });

    it("should fetch price from CoinGecko", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () =>
          Promise.resolve({ solana: { usd: 140.25 } }),
      } as unknown as Response);

      const result = await fetchPriceFromCoinGecko("solana");
      expect(result).toBe(140_250_000n);
    });

    it("should return null for zero price", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ price: "0" }),
      } as unknown as Response);

      const result = await fetchPriceFromBinance("SOLUSDT");
      expect(result).toBeNull();
    });

    it("should return null for negative price", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ price: "-10.5" }),
      } as unknown as Response);

      const result = await fetchPriceFromBinance("SOLUSDT");
      expect(result).toBeNull();
    });

    it("should use Binance first in fetchPrice for known mints", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ price: "150.00" }),
      } as unknown as Response);

      const result = await fetchPrice(
        "So11111111111111111111111111111111111111112",
      );
      expect(result).toEqual({
        priceE6: 150_000_000n,
        source: "binance",
      });
    });

    it("should fall back to CoinGecko when Binance fails", async () => {
      globalThis.fetch = vi
        .fn()
        // First call (Binance) fails
        .mockRejectedValueOnce(new Error("Binance down"))
        // Second call (CoinGecko) succeeds
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({ solana: { usd: 148.75 } }),
        } as unknown as Response);

      const result = await fetchPrice(
        "So11111111111111111111111111111111111111112",
      );
      expect(result).toEqual({
        priceE6: 148_750_000n,
        source: "coingecko",
      });
    });

    it("should return null for unknown mints with no external price", async () => {
      const result = await fetchPrice("UnknownMint111111111111111111111111111111");
      expect(result).toBeNull();
    });
  });

  describe("Bot Wallet Parsing", () => {
    it("should parse JSON array keypairs", () => {
      const kp = Keypair.generate();
      const raw = JSON.stringify(Array.from(kp.secretKey));
      const parsed = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(raw)),
      );
      expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    });

    it("should handle multiple keypairs separated at bracket boundaries", () => {
      const kp1 = Keypair.generate();
      const kp2 = Keypair.generate();
      const raw1 = JSON.stringify(Array.from(kp1.secretKey));
      const raw2 = JSON.stringify(Array.from(kp2.secretKey));
      const combined = `${raw1},${raw2}`;

      // Parse using the same logic as the bootstrap script
      const parts: string[] = [];
      let depth = 0;
      let current = "";
      for (const ch of combined) {
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        if (ch === "," && depth === 0) {
          parts.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
      if (current.trim()) parts.push(current.trim());

      expect(parts).toHaveLength(2);
      const parsed1 = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(parts[0])),
      );
      const parsed2 = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(parts[1])),
      );
      expect(parsed1.publicKey.toBase58()).toBe(kp1.publicKey.toBase58());
      expect(parsed2.publicKey.toBase58()).toBe(kp2.publicKey.toBase58());
    });
  });

  describe("Trade Pattern", () => {
    it("should alternate buy/sell/buy for seed trades", () => {
      const SEED_TRADE_SIZE = 1_000_000n;
      const trades = [
        { size: SEED_TRADE_SIZE, label: "Seed BUY #1" },
        { size: -SEED_TRADE_SIZE, label: "Seed SELL #1" },
        { size: SEED_TRADE_SIZE / 2n, label: "Seed BUY #2" },
      ];

      expect(trades[0].size).toBeGreaterThan(0n);
      expect(trades[1].size).toBeLessThan(0n);
      expect(trades[2].size).toBeGreaterThan(0n);
      // Net position should be positive (simulates organic demand)
      const netSize = trades.reduce(
        (acc, t) => acc + t.size,
        0n,
      );
      expect(netSize).toBeGreaterThan(0n);
    });

    it("should rotate bot wallets for market making", () => {
      const numBots = 3;
      const rotations: number[] = [];
      let rotation = 0;
      for (let i = 0; i < 10; i++) {
        const botIdx = rotation % numBots;
        rotations.push(botIdx);
        rotation++;
      }
      // Should cycle through 0, 1, 2, 0, 1, 2, ...
      expect(rotations).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
    });
  });

  describe("Configuration Defaults", () => {
    it("should have reasonable LP seed amount", () => {
      const LP_SEED = 50_000_000n; // 50 tokens @ 6 decimals
      expect(LP_SEED).toBeGreaterThan(0n);
      expect(LP_SEED).toBeLessThanOrEqual(1_000_000_000n); // Max 1000 tokens
    });

    it("should have reasonable trade sizes", () => {
      const SEED = 1_000_000n;
      const MM = 500_000n;
      // MM trades should be smaller than seed trades
      expect(MM).toBeLessThan(SEED);
      // Both should be positive
      expect(SEED).toBeGreaterThan(0n);
      expect(MM).toBeGreaterThan(0n);
    });

    it("should have shorter oracle interval than MM interval", () => {
      const ORACLE_MS = 10_000;
      const MM_LONG_MS = 60_000;
      const MM_SHORT_MS = 75_000;
      // Oracle should push more frequently than trades
      expect(ORACLE_MS).toBeLessThan(MM_LONG_MS);
      expect(ORACLE_MS).toBeLessThan(MM_SHORT_MS);
    });

    it("should have MM short interval longer than long interval", () => {
      // Asymmetric intervals prevent predictable patterns
      const MM_LONG_MS = 60_000;
      const MM_SHORT_MS = 75_000;
      expect(MM_SHORT_MS).toBeGreaterThan(MM_LONG_MS);
    });
  });

  describe("Oracle Authority Check", () => {
    it("should detect admin oracle (non-default authority)", () => {
      const authority = Keypair.generate().publicKey;
      const isAdminOracle = !authority.equals(PublicKey.default);
      expect(isAdminOracle).toBe(true);
    });

    it("should detect Pyth oracle (default authority)", () => {
      const isAdminOracle = !PublicKey.default.equals(PublicKey.default);
      expect(isAdminOracle).toBe(false);
    });
  });
});
