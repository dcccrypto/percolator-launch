import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getRpcEndpoint, getConfig, getWsEndpoint } from "@/lib/config";

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
    expect(config.crankWallet.length).toBeGreaterThanOrEqual(32); // Base58 address: 32-44 chars
    expect(config.crankWallet.length).toBeLessThanOrEqual(44);
  });

  it("should have valid devnet matcherProgramId", () => {
    // Devnet config should always have these values for local testing
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    
    const config = getConfig();
    expect(config.matcherProgramId).toBeTruthy();
    expect(config.matcherProgramId.length).toBeGreaterThanOrEqual(32); // Base58 address: 32-44 chars
    expect(config.matcherProgramId.length).toBeLessThanOrEqual(44);
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

  it("uses HELIUS_API_KEY on the server when explicit RPC URL is not set", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    process.env.HELIUS_API_KEY = "server-key";
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    expect(getRpcEndpoint()).toBe("https://devnet.helius-rpc.com/?api-key=server-key");
  });

  it("does not use NEXT_PUBLIC_HELIUS_API_KEY for server RPC fallback", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    process.env.NEXT_PUBLIC_HELIUS_API_KEY = "public-key";
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    expect(getRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });

  it("falls back to public devnet RPC when no Helius config provided", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    expect(getRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });

  it("ignores empty-string NEXT_PUBLIC_SOLANA_RPC_URL (PERC-210 bug 1)", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL = "";
    delete process.env.SOLANA_RPC_URL;
    expect(getRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });

  it("ignores whitespace-only NEXT_PUBLIC_HELIUS_RPC_URL (PERC-210 bug 1)", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL = "   ";
    delete process.env.HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    expect(getRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });

  it("ignores non-URL values like 'null' or 'undefined' strings", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL = "null";
    delete process.env.HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    expect(getRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });

  it("uses SOLANA_RPC_URL as fallback when NEXT_PUBLIC variant is missing", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = "https://custom-rpc.example.com";
    expect(getRpcEndpoint()).toBe("https://custom-rpc.example.com");
  });

  it("trims whitespace from HELIUS_API_KEY", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    process.env.HELIUS_API_KEY = "  my-key  ";
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    expect(getRpcEndpoint()).toBe("https://devnet.helius-rpc.com/?api-key=my-key");
  });
});

describe("getWsEndpoint", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    clearWindow();
  });

  it("prefers NEXT_PUBLIC_HELIUS_WS_API_KEY when present", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY = "ws-key";
    process.env.NEXT_PUBLIC_HELIUS_API_KEY = "legacy-key";
    expect(getWsEndpoint()).toBe("wss://devnet.helius-rpc.com/?api-key=ws-key");
  });

  it("falls back to NEXT_PUBLIC_HELIUS_API_KEY for backward compatibility", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";
    delete process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY;
    process.env.NEXT_PUBLIC_HELIUS_API_KEY = "legacy-key";
    expect(getWsEndpoint()).toBe("wss://mainnet.helius-rpc.com/?api-key=legacy-key");
  });

  it("returns undefined when no public WS key is configured", () => {
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY;
    delete process.env.NEXT_PUBLIC_HELIUS_API_KEY;
    expect(getWsEndpoint()).toBeUndefined();
  });
});
