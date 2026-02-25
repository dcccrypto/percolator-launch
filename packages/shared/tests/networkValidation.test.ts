import { describe, it, expect } from "vitest";
import {
  validateNetworkConfig,
  ensureNetworkConfigValid,
  isMainnet,
  getDefaultRpcUrl,
} from "../src/networkValidation.js";

// ============================================================================
// validateNetworkConfig
// ============================================================================

describe("validateNetworkConfig", () => {
  // The source regex is [1-9A-HJ-NP-Z]{40,45} — uppercase+digits only.
  // Use a test ID that matches this pattern.
  const validProgramId = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ123456789ABC";
  const validDevnetEnv = {
    NETWORK: "devnet",
    PROGRAM_ID: validProgramId,
  };

  describe("NETWORK validation", () => {
    it("accepts devnet", () => {
      const result = validateNetworkConfig(validDevnetEnv);
      expect(result.network).toBe("devnet");
    });

    it("accepts testnet", () => {
      const result = validateNetworkConfig({
        ...validDevnetEnv,
        NETWORK: "testnet",
      });
      expect(result.network).toBe("testnet");
    });

    it("accepts mainnet with FORCE_MAINNET", () => {
      const result = validateNetworkConfig({
        ...validDevnetEnv,
        NETWORK: "mainnet",
        FORCE_MAINNET: "1",
        RPC_URL: "https://api.mainnet-beta.solana.com",
      });
      expect(result.network).toBe("mainnet");
    });

    it("is case-insensitive", () => {
      const result = validateNetworkConfig({
        ...validDevnetEnv,
        NETWORK: "DEVNET",
      });
      expect(result.network).toBe("devnet");
    });

    it("trims whitespace", () => {
      const result = validateNetworkConfig({
        ...validDevnetEnv,
        NETWORK: "  devnet  ",
      });
      expect(result.network).toBe("devnet");
    });

    it("throws for invalid network", () => {
      expect(() =>
        validateNetworkConfig({ ...validDevnetEnv, NETWORK: "staging" })
      ).toThrow("NETWORK env var must be set");
    });

    it("throws for empty network", () => {
      expect(() =>
        validateNetworkConfig({ ...validDevnetEnv, NETWORK: "" })
      ).toThrow("NETWORK env var must be set");
    });

    it("throws for undefined network", () => {
      expect(() =>
        validateNetworkConfig({ PROGRAM_ID: validDevnetEnv.PROGRAM_ID })
      ).toThrow("NETWORK env var must be set");
    });
  });

  describe("Mainnet safety guard", () => {
    it("throws for mainnet without FORCE_MAINNET", () => {
      expect(() =>
        validateNetworkConfig({
          ...validDevnetEnv,
          NETWORK: "mainnet",
          RPC_URL: "https://api.mainnet-beta.solana.com",
        })
      ).toThrow("MAINNET SAFETY GUARD");
    });

    it("mainnet requires RPC_URL", () => {
      expect(() =>
        validateNetworkConfig({
          ...validDevnetEnv,
          NETWORK: "mainnet",
          FORCE_MAINNET: "1",
        })
      ).toThrow("RPC_URL env var MUST be set for mainnet");
    });
  });

  describe("RPC_URL handling", () => {
    it("uses provided RPC_URL", () => {
      const customUrl = "https://my-rpc.example.com";
      const result = validateNetworkConfig({
        ...validDevnetEnv,
        RPC_URL: customUrl,
      });
      expect(result.rpcUrl).toBe(customUrl);
    });

    it("defaults to devnet RPC when not provided for devnet", () => {
      const result = validateNetworkConfig(validDevnetEnv);
      expect(result.rpcUrl).toBe("https://api.devnet.solana.com");
    });

    it("defaults to testnet RPC when not provided for testnet", () => {
      const result = validateNetworkConfig({
        ...validDevnetEnv,
        NETWORK: "testnet",
      });
      expect(result.rpcUrl).toBe("https://api.testnet.solana.com");
    });
  });

  describe("PROGRAM_ID validation", () => {
    it("throws for missing PROGRAM_ID", () => {
      expect(() =>
        validateNetworkConfig({ NETWORK: "devnet" })
      ).toThrow("PROGRAM_ID env var MUST be set");
    });

    it("throws for empty PROGRAM_ID", () => {
      expect(() =>
        validateNetworkConfig({ NETWORK: "devnet", PROGRAM_ID: "" })
      ).toThrow("PROGRAM_ID env var MUST be set");
    });

    it("throws for invalid PROGRAM_ID format", () => {
      expect(() =>
        validateNetworkConfig({
          NETWORK: "devnet",
          PROGRAM_ID: "not-a-valid-address",
        })
      ).toThrow("does not look like a valid Solana address");
    });

    it("accepts valid base58 program ID", () => {
      const result = validateNetworkConfig(validDevnetEnv);
      expect(result.programIds).toEqual([validDevnetEnv.PROGRAM_ID]);
    });
  });

  describe("Return structure", () => {
    it("returns network, rpcUrl, and programIds", () => {
      const result = validateNetworkConfig(validDevnetEnv);
      expect(result).toHaveProperty("network");
      expect(result).toHaveProperty("rpcUrl");
      expect(result).toHaveProperty("programIds");
      expect(Array.isArray(result.programIds)).toBe(true);
    });
  });
});

// ============================================================================
// ensureNetworkConfigValid
// ============================================================================

describe("ensureNetworkConfigValid", () => {
  it("throws for invalid config (wrapped error)", () => {
    const env = { NETWORK: "invalid" } as unknown as NodeJS.ProcessEnv;
    expect(() => ensureNetworkConfigValid(env)).toThrow();
  });

  it("does not throw for valid devnet config", () => {
    const env = {
      NETWORK: "devnet",
      PROGRAM_ID: "123456789ABCDEFGHJKLMNPQRSTUVWXYZ123456789ABC",
    } as unknown as NodeJS.ProcessEnv;
    expect(() => ensureNetworkConfigValid(env)).not.toThrow();
  });
});

// ============================================================================
// isMainnet
// ============================================================================

describe("isMainnet", () => {
  it("returns true for mainnet", () => {
    expect(isMainnet({ NETWORK: "mainnet" } as any)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isMainnet({ NETWORK: "MAINNET" } as any)).toBe(true);
    expect(isMainnet({ NETWORK: "Mainnet" } as any)).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isMainnet({ NETWORK: "  mainnet  " } as any)).toBe(true);
  });

  it("returns false for devnet", () => {
    expect(isMainnet({ NETWORK: "devnet" } as any)).toBe(false);
  });

  it("returns false for testnet", () => {
    expect(isMainnet({ NETWORK: "testnet" } as any)).toBe(false);
  });

  it("returns false for empty/undefined", () => {
    expect(isMainnet({} as any)).toBe(false);
    expect(isMainnet({ NETWORK: "" } as any)).toBe(false);
  });
});

// ============================================================================
// getDefaultRpcUrl
// ============================================================================

describe("getDefaultRpcUrl", () => {
  it("returns mainnet URL", () => {
    expect(getDefaultRpcUrl("mainnet")).toBe(
      "https://api.mainnet-beta.solana.com"
    );
  });

  it("returns testnet URL", () => {
    expect(getDefaultRpcUrl("testnet")).toBe(
      "https://api.testnet.solana.com"
    );
  });

  it("returns devnet URL", () => {
    expect(getDefaultRpcUrl("devnet")).toBe(
      "https://api.devnet.solana.com"
    );
  });
});
