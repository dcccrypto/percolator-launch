// @vitest-environment node
/**
 * isMarketauthComplete — the completeness signal the on-chain-discovery markets
 * path uses to hide markets that never finished the create-market wizard.
 *
 * A market is complete once percolator-stake InitPool (the wizard's final
 * on-chain step) has rotated `marketauth` from the creator's wallet to the
 * stake-pool PDA. So `marketauth == derive("stake_pool", slab)` proves it ran;
 * a market that died mid-creation still has `marketauth == creator wallet` and
 * must read as incomplete so the list filter hides it.
 *
 * The SDK's `deriveStakePool` and the config's `vaultProgramId` (which becomes
 * the module-level STAKE_PROGRAM_ID) are mocked so the test controls the
 * expected PDA without a chain/PDA computation.
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import { PublicKey } from "@solana/web3.js";

const STAKE_POOL_PDA = new PublicKey("So11111111111111111111111111111111111111112");
const CREATOR_WALLET = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const SLAB = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");

vi.mock("@percolatorct/sdk", () => ({
  // Only deriveStakePool matters here; the rest just need to exist as exports
  // because live-market-state imports them at module load.
  deriveStakePool: vi.fn(() => [STAKE_POOL_PDA]),
  isV17Account: vi.fn(),
  parseWrapperConfigV17: vi.fn(),
  parseMarketGroupV17OI: vi.fn(),
  V17_HEADER_LEN: 16,
  V17_MARKET_GROUP_OFF: 592,
}));

// STAKE_PROGRAM_ID is derived from getConfig().vaultProgramId at module load —
// a real devnet vault program id so the completeness check is ENABLED (mainnet,
// where it is absent, treats every market as complete and is not what we test).
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", network: "devnet" }),
}));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: vi.fn() }));
vi.mock("@/lib/health", () => ({ sanitizeOnChainValue: (v: bigint) => v, isSentinelValue: () => false }));

import { deriveStakePool } from "@percolatorct/sdk";
import { isMarketauthComplete } from "@/lib/live-market-state";

describe("isMarketauthComplete", () => {
  it("complete when marketauth has rotated to the stake-pool PDA (InitPool ran)", () => {
    expect(isMarketauthComplete(STAKE_POOL_PDA, SLAB)).toBe(true);
  });

  it("incomplete when marketauth is still the creator wallet (never staked)", () => {
    expect(isMarketauthComplete(CREATOR_WALLET, SLAB)).toBe(false);
  });

  it("fails closed (incomplete) when PDA derivation throws", () => {
    (deriveStakePool as unknown as Mock).mockImplementationOnce(() => {
      throw new Error("derive failure");
    });
    expect(isMarketauthComplete(CREATOR_WALLET, SLAB)).toBe(false);
  });
});
