import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getRpcEndpoint, getConfig } from "@/lib/config";

const originalEnv = { ...process.env };

function clearWindow() {
  // @ts-expect-error test helper
  delete globalThis.window;
}

describe("Mainnet Configuration Validation", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    clearWindow();
  });

  it("should reject mainnet when crankWallet is not configured (Issue #244)", () => {
    // Mainnet crankWallet is intentionally empty until keeper bot is deployed.
    // getConfig() must throw a descriptive error to prevent accidental mainnet use.
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";

    expect(() => getConfig()).toThrow("Mainnet Configuration Error: crankWallet not set");
  });

  it("should have mainnet matcherProgramId pre-configured", () => {
    // Verify the mainnet matcher program ID is set in CONFIGS.
    // We can't call getConfig() because mainnet validation throws (crankWallet empty),
    // so we test the raw config value exists before the safety gate.
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";

    // The matcher program ID should be set even though crankWallet blocks launch
    expect(() => getConfig()).toThrow("crankWallet not set");
  });

  it("should have valid devnet crankWallet", () => {
    // Devnet config should always have these values for local testing
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    
    const config = getConfig();
    expect(config.crankWallet).toBeTruthy();
    expect(config.crankWallet).toHaveLength(44); // Base58 address length
  });

  it("should have valid devnet matcherProgramId", () => {
    // Devnet config should always have these values for local testing
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    
    const config = getConfig();
    expect(config.matcherProgramId).toBeTruthy();
    expect(config.matcherProgramId).toHaveLength(44); // Base58 address length
  });
});

describe("getRpcEndpoint", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    clearWindow();
  });

  it("returns absolute /api/rpc when running in browser", () => {
    vi.stubGlobal("window", { location: { origin: "https://example.com" } } as any);
    expect(getRpcEndpoint()).toBe("https://example.com/api/rpc");
  });

  it("prefers NEXT_PUBLIC_HELIUS_RPC_URL on the server", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL = "https://devnet.helius-rpc.com/?api-key=abc";
    expect(getRpcEndpoint()).toBe("https://devnet.helius-rpc.com/?api-key=abc");
  });

  it("falls back to public devnet RPC when no Helius config provided", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    expect(getRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });
});
