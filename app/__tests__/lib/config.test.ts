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

  it("should warn (not throw) when mainnet crankWallet is not configured (PERC-8109)", () => {
    // Mainnet crankWallet is intentionally empty until keeper bot is deployed.
    // Downgraded from throw to console.warn for mainnet beta launch.
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => getConfig()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("crankWallet not set"));
    warnSpy.mockRestore();
  });

  it("should have mainnet matcherProgramId pre-configured", () => {
    // Verify the mainnet matcher program ID is set in CONFIGS.
    // crankWallet empty now warns instead of throwing, so getConfig() succeeds.
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = getConfig();
    expect(config.matcherProgramId).toBeTruthy();
    warnSpy.mockRestore();
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

  it("falls back to public devnet RPC when no Helius config provided (PERC-469)", () => {
    // NEXT_PUBLIC_HELIUS_API_KEY removed in PERC-469 — server fallback must never use it
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
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

  it("uses NEXT_PUBLIC_HELIUS_WS_API_KEY for devnet", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY = "ws-key";
    expect(getWsEndpoint()).toBe("wss://devnet.helius-rpc.com/?api-key=ws-key");
  });

  it("uses NEXT_PUBLIC_HELIUS_WS_API_KEY for mainnet", () => {
    clearWindow();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";
    process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY = "ws-key";
    expect(getWsEndpoint()).toBe("wss://mainnet.helius-rpc.com/?api-key=ws-key");
  });

  it("returns undefined when NEXT_PUBLIC_HELIUS_WS_API_KEY is not set (PERC-469)", () => {
    // HELIUS_API_KEY is server-only and cannot be read client-side — getWsEndpoint()
    // must not fall back to it or any NEXT_PUBLIC_HELIUS_API_KEY (removed in PERC-469).
    clearWindow();
    delete process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY;
    process.env.HELIUS_API_KEY = "server-key"; // should be ignored
    expect(getWsEndpoint()).toBeUndefined();
  });

  it("returns undefined when no keys are configured", () => {
    clearWindow();
    delete process.env.HELIUS_API_KEY;
    delete process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY;
    expect(getWsEndpoint()).toBeUndefined();
  });
});
