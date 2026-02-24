import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };
    // Reset modules to ensure config is reloaded
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
    vi.resetModules();
  });

  it("should load defaults when no env vars are set", async () => {
    // Clear all config-related env vars
    delete process.env.NODE_ENV;
    delete process.env.RPC_URL;
    delete process.env.PROGRAM_ID;
    delete process.env.ALL_PROGRAM_IDS;
    delete process.env.HELIUS_API_KEY;
    delete process.env.CRANK_KEYPAIR;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.FALLBACK_RPC_URL;
    delete process.env.PORT;
    delete process.env.CRANK_INTERVAL_MS;
    delete process.env.CRANK_INACTIVE_INTERVAL_MS;
    delete process.env.DISCOVERY_INTERVAL_MS;
    delete process.env.HELIUS_WEBHOOK_SECRET;
    delete process.env.WEBHOOK_URL;

    const { config } = await import("../src/config.js");

    expect(config.rpcUrl).toBe("https://devnet.helius-rpc.com/?api-key=");
    expect(config.programId).toBe("4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih");
    expect(config.allProgramIds).toEqual([
      "4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih",
      "p9F84kJm39fQP3AwZSta2tB7oudUKPQd7zFuNHR7vas",
      "6oLLu8wLe6tmEkcGhHfNXNEBZFgKBzcZFheNtgJvZQaS",
    ]);
    expect(config.crankKeypair).toBe("");
    expect(config.supabaseUrl).toBe("");
    expect(config.supabaseKey).toBe("");
    expect(config.supabaseServiceRoleKey).toBe("");
    expect(config.heliusApiKey).toBe("");
    expect(config.fallbackRpcUrl).toBe("https://api.devnet.solana.com");
    expect(config.port).toBe(3001);
    expect(config.crankIntervalMs).toBe(30_000);
    expect(config.crankInactiveIntervalMs).toBe(60_000);
    expect(config.discoveryIntervalMs).toBe(300_000);
    expect(config.webhookSecret).toBe("");
    expect(config.webhookUrl).toBe("");
  });

  it("should read env vars correctly", async () => {
    process.env.RPC_URL = "https://custom-rpc.com";
    process.env.PROGRAM_ID = "CustomProgramId111111111111111111111111111";
    process.env.ALL_PROGRAM_IDS = "Prog1,Prog2,Prog3";
    process.env.HELIUS_API_KEY = "test-helius-key";
    process.env.CRANK_KEYPAIR = "test-keypair";
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_KEY = "test-supabase-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.FALLBACK_RPC_URL = "https://custom-fallback.com";
    process.env.PORT = "4000";
    process.env.CRANK_INTERVAL_MS = "5000";
    process.env.CRANK_INACTIVE_INTERVAL_MS = "30000";
    process.env.DISCOVERY_INTERVAL_MS = "45000";
    process.env.HELIUS_WEBHOOK_SECRET = "webhook-secret-123";
    process.env.WEBHOOK_URL = "https://webhook.example.com";

    const { config } = await import("../src/config.js");

    expect(config.rpcUrl).toBe("https://custom-rpc.com");
    expect(config.programId).toBe("CustomProgramId111111111111111111111111111");
    expect(config.allProgramIds).toEqual(["Prog1", "Prog2", "Prog3"]);
    expect(config.heliusApiKey).toBe("test-helius-key");
    expect(config.crankKeypair).toBe("test-keypair");
    expect(config.supabaseUrl).toBe("https://test.supabase.co");
    expect(config.supabaseKey).toBe("test-supabase-key");
    expect(config.supabaseServiceRoleKey).toBe("test-service-role-key");
    expect(config.fallbackRpcUrl).toBe("https://custom-fallback.com");
    expect(config.port).toBe(4000);
    expect(config.crankIntervalMs).toBe(5000);
    expect(config.crankInactiveIntervalMs).toBe(30000);
    expect(config.discoveryIntervalMs).toBe(45000);
    expect(config.webhookSecret).toBe("webhook-secret-123");
    expect(config.webhookUrl).toBe("https://webhook.example.com");
  });

  it("should correctly parse allProgramIds from comma-separated string", async () => {
    delete process.env.NODE_ENV;
    process.env.ALL_PROGRAM_IDS = "Prog1,Prog2,,Prog3,";

    const { config } = await import("../src/config.js");

    // Empty strings should be filtered out
    expect(config.allProgramIds).toEqual(["Prog1", "Prog2", "Prog3"]);
  });

  it("should handle allProgramIds with spaces and empty values", async () => {
    delete process.env.NODE_ENV;
    process.env.ALL_PROGRAM_IDS = "Prog1, Prog2 ,, ,Prog3";

    const { config } = await import("../src/config.js");

    // Spaces are preserved, but empty strings filtered
    expect(config.allProgramIds).toEqual(["Prog1", " Prog2 ", " ", "Prog3"]);
  });

  it("should throw error in production mode when required env vars are not set", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.RPC_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(async () => {
      await import("../src/config.js");
    }).rejects.toThrow("Environment validation failed");
  });

  it("should not throw error in production mode when all required env vars are set", async () => {
    process.env.NODE_ENV = "production";
    process.env.RPC_URL = "https://mainnet.solana.com";
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_KEY = "test-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

    const { config } = await import("../src/config.js");

    expect(config.rpcUrl).toBe("https://mainnet.solana.com");
  });

  it("should not throw error when not in production and RPC_URL is not set", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.RPC_URL;

    const { config } = await import("../src/config.js");

    expect(config.rpcUrl).toContain("devnet.helius-rpc.com");
  });

  it("should correctly parse allProgramIds defaults when ALL_PROGRAM_IDS is not set", async () => {
    delete process.env.ALL_PROGRAM_IDS;
    delete process.env.NODE_ENV;

    const { config } = await import("../src/config.js");

    // Default program IDs must be an array of 3 known program addresses
    expect(Array.isArray(config.allProgramIds)).toBe(true);
    expect(config.allProgramIds).toHaveLength(3);
    expect(config.allProgramIds[0]).toBe("4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih");
    expect(config.allProgramIds[1]).toBe("p9F84kJm39fQP3AwZSta2tB7oudUKPQd7zFuNHR7vas");
    expect(config.allProgramIds[2]).toBe("6oLLu8wLe6tmEkcGhHfNXNEBZFgKBzcZFheNtgJvZQaS");
  });

  it("should reject invalid NODE_ENV values with a clear validation error", async () => {
    // NODE_ENV is validated against an allowlist: "development" | "production" | "test"
    // Values like "staging", "ci", "qa" are not valid and should throw
    for (const invalidEnv of ["staging", "ci", "qa", "review", "PRODUCTION", "Dev"]) {
      vi.resetModules();
      process.env.NODE_ENV = invalidEnv;
      delete process.env.RPC_URL;
      delete process.env.SUPABASE_URL;

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("Environment validation failed");
    }
  });

  it("should accept valid NODE_ENV values without error", async () => {
    for (const validEnv of ["development", "test"]) {
      vi.resetModules();
      process.env.NODE_ENV = validEnv;
      delete process.env.RPC_URL;
      delete process.env.SUPABASE_URL;

      // Valid NODE_ENV values should not throw in non-production mode
      const { config } = await import("../src/config.js");
      expect(config.rpcUrl).toContain("devnet.helius-rpc.com");
    }
  });
});
