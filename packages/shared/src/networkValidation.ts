/**
 * Network Validation Module
 * 
 * Ensures that network configuration (RPC, PROGRAM_ID) matches the intended
 * deployment network. Prevents accidental mainnet operations on devnet/testnet.
 */

export type NetworkType = "devnet" | "testnet" | "mainnet";

interface NetworkConfig {
  network: NetworkType;
  rpcUrl: string;
  programIds: string[];
}

/**
 * Validate network configuration at startup.
 * Throws if configuration is invalid or unsafe.
 */
export function validateNetworkConfig(env: {
  NETWORK?: string;
  RPC_URL?: string;
  PROGRAM_ID?: string;
  FORCE_MAINNET?: string;
}): NetworkConfig {
  // 1. Validate NETWORK is set
  const network = (env.NETWORK?.toLowerCase() || "").trim() as NetworkType;
  
  if (!["devnet", "testnet", "mainnet"].includes(network)) {
    throw new Error(
      `❌ NETWORK env var must be set to 'devnet', 'testnet', or 'mainnet'.\n` +
      `Got: ${env.NETWORK || "(not set)"}\n\n` +
      `Example: export NETWORK=devnet\n` +
      `Then: npm run api`
    );
  }

  // 2. Mainnet requires explicit force flag
  if (network === "mainnet" && !env.FORCE_MAINNET) {
    throw new Error(
      `⛔ MAINNET SAFETY GUARD ACTIVE\n\n` +
      `You are trying to run against mainnet.\n` +
      `This requires explicit confirmation to prevent accidental fund loss.\n\n` +
      `To proceed, set:\n` +
      `  export FORCE_MAINNET=1\n` +
      `  export NETWORK=mainnet\n\n` +
      `Then run your command again.`
    );
  }

  // 3. Validate RPC_URL is set for mainnet (devnet can infer)
  let rpcUrl = env.RPC_URL || "";
  
  if (!rpcUrl) {
    if (network === "mainnet") {
      throw new Error(
        `❌ RPC_URL env var MUST be set for mainnet operations.\n` +
        `Do not rely on defaults for mainnet.\n\n` +
        `Example: export RPC_URL=https://api.mainnet-beta.solana.com`
      );
    }

    if (network === "testnet") {
      rpcUrl = "https://api.testnet.solana.com";
    } else {
      rpcUrl = "https://api.devnet.solana.com";
    }
  }

  // 4. Parse and validate PROGRAM_ID
  const programIdEnv = env.PROGRAM_ID || "";
  if (!programIdEnv) {
    throw new Error(
      `❌ PROGRAM_ID env var MUST be set.\n` +
      `Do not rely on hardcoded defaults.\n\n` +
      `Example: export PROGRAM_ID=FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD\n\n` +
      `To find your program ID:\n` +
      `  Devnet: solana program show --address <pubkey> --url devnet\n` +
      `  Mainnet: solana program show --address <pubkey> --url mainnet-beta`
    );
  }

  // 5. Validate program ID looks like a valid Solana address (base58, ~44 chars)
  if (!/[1-9A-HJ-NP-Z]{40,45}/.test(programIdEnv)) {
    throw new Error(
      `❌ PROGRAM_ID does not look like a valid Solana address.\n` +
      `Got: ${programIdEnv}\n` +
      `Expected: base58-encoded 32-byte address (~44 characters)`
    );
  }

  return {
    network,
    rpcUrl,
    programIds: [programIdEnv],
  };
}

/**
 * Validate configuration and throw with helpful error messages on failure.
 * Call this once at app startup.
 */
export function ensureNetworkConfigValid(env: NodeJS.ProcessEnv): void {
  try {
    validateNetworkConfig(env as any);
  } catch (error) {
    if (error instanceof Error) {
      console.error("\n" + "=".repeat(70));
      console.error(error.message);
      console.error("=".repeat(70) + "\n");
    }
    // Re-throw so callers (including test harnesses) can handle it.
    // App entry points should catch and exit if needed.
    throw error instanceof Error
      ? error
      : new Error("Network configuration validation failed");
  }
}

/**
 * Check if we're running against mainnet.
 * Useful for conditional logic that should behave differently on mainnet.
 */
export function isMainnet(env: NodeJS.ProcessEnv): boolean {
  return (env.NETWORK || "").toLowerCase().trim() === "mainnet";
}

/**
 * Get the expected RPC URL for a network (used for validation).
 */
export function getDefaultRpcUrl(network: NetworkType): string {
  switch (network) {
    case "mainnet":
      return "https://api.mainnet-beta.solana.com";
    case "testnet":
      return "https://api.testnet.solana.com";
    case "devnet":
    default:
      return "https://api.devnet.solana.com";
  }
}
