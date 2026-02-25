import { describe, it, expect, beforeEach, vi } from "vitest";
import { getStoredMarkets, addMarket, getMarket, type MarketInfo } from "../../lib/markets";

// Provide a minimal localStorage mock for jsdom environments where it may not be fully available
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) delete store[k]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });

const mockMarket: MarketInfo = {
  slab: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  mint: "So11111111111111111111111111111111111111112",
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  createdAt: "2026-01-01T00:00:00Z",
  deployer: "Deploy1111111111111111111111111111111111111",
};

const mockMarket2: MarketInfo = {
  slab: "BtcKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBTC",
  mint: "BtcMint1111111111111111111111111111111111112",
  symbol: "BTC",
  name: "Bitcoin",
  decimals: 8,
  createdAt: "2026-01-02T00:00:00Z",
  deployer: "Deploy2222222222222222222222222222222222222",
};

const STORAGE_KEY = "percolator_launch_markets";

describe("getStoredMarkets", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("returns empty array when no markets stored", () => {
    expect(getStoredMarkets()).toEqual([]);
  });

  it("returns stored markets", () => {
    store[STORAGE_KEY] = JSON.stringify([mockMarket]);
    expect(getStoredMarkets()).toEqual([mockMarket]);
  });

  it("returns empty array for invalid JSON", () => {
    store[STORAGE_KEY] = "not-json";
    expect(getStoredMarkets()).toEqual([]);
  });
});

describe("addMarket", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("adds a new market to storage", () => {
    addMarket(mockMarket);
    const stored = JSON.parse(store[STORAGE_KEY] || "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].symbol).toBe("SOL");
  });

  it("does not add duplicate market (same slab)", () => {
    addMarket(mockMarket);
    addMarket(mockMarket);
    const stored = JSON.parse(store[STORAGE_KEY] || "[]");
    expect(stored).toHaveLength(1);
  });

  it("adds multiple different markets", () => {
    addMarket(mockMarket);
    addMarket(mockMarket2);
    const stored = JSON.parse(store[STORAGE_KEY] || "[]");
    expect(stored).toHaveLength(2);
  });
});

describe("getMarket", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("returns undefined when market not found", () => {
    expect(getMarket("nonexistent")).toBeUndefined();
  });

  it("returns market by slab address", () => {
    addMarket(mockMarket);
    addMarket(mockMarket2);
    const found = getMarket(mockMarket.slab);
    expect(found).toBeDefined();
    expect(found?.symbol).toBe("SOL");
  });

  it("returns undefined for wrong slab", () => {
    addMarket(mockMarket);
    expect(getMarket("wrong-slab")).toBeUndefined();
  });
});
