// @vitest-environment node
/**
 * App bug 2026-10-29 (product review finding 3): the Earn HUB valued a BOUND vault at registry
 * shares + distributed fees, in both the TVL (fetchCuratedVaultsOnChain) and the table's
 * "Your Value" (readEarnPositions). Both now use the withdraw pricing (readBoundVaultPricing ->
 * earnPanelPricing), so a loss shows there exactly as on the vault page and in the withdraw quote.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import * as C from "@/lib/limits/constants";

const m = vi.hoisted(() => ({ pricing: vi.fn(), chunked: vi.fn() }));
vi.mock("@/lib/limits/earn-bound-pricing", () => ({ readBoundVaultPricing: m.pricing }));
vi.mock("@/lib/rpc-chunk", () => ({ getMultipleAccountsInfoChunked: m.chunked }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ programId: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB" }),
  getRpcEndpoint: () => "http://localhost:8899",
}));
vi.mock("@/lib/program-upgrade-detect", () => ({ programUpgradeState: async () => "post", earnNavFloorLive: async () => true }));
vi.mock("@/lib/v22/records", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/records")>()),
  // 1,000 shares + 5 USDC of distributed fees: the old proxy
  parseLpVaultRegistry: () => ({ totalLpSharesOutstanding: 1_000_000_000n, feeDistributionTotalAtoms: 5_000_000n, redemptionCooldownSlots: 150n }),
  parseLpRedemption: () => ({ shares: 0n }),
}));
vi.mock("@/lib/limits/earn-split-pot", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/earn-split-pot")>()),
  readSplitPotState: async () => null,
  splitPotLedgerKeys: () => null,
}));

import { fetchCuratedVaultsOnChain } from "@/hooks/useEarnStats";
import { readEarnPositions } from "@/lib/limits/earn-positions";

const PROG = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const WALLET = Keypair.generate().publicKey;
const SLAB = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const registry = (bound: 0 | 1) => {
  const d = Buffer.alloc(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
  d[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
  d[C.REG_VAULT_LP_BOUND_FLAG] = bound;
  return { data: d, owner: PROG, lamports: 1, executable: false, rentEpoch: 0 };
};
const tokenAcct = (amount: bigint) => {
  const d = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: PublicKey.default, owner: WALLET, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, d);
  return { data: d, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
};
// After a loss: 1,000 shares redeem for 822 USDC together.
const LOSS = { totalShares: 1_000_000_000n, withdrawSeniorValue: 822_000_000n };

beforeEach(() => {
  __setDevnetV22ForTest(false);
  m.pricing.mockReset();
  m.chunked.mockReset();
});
afterEach(() => __setDevnetV22ForTest(null));

describe("hub TVL (fetchCuratedVaultsOnChain), bound vault", () => {
  it("after a loss: the senior value (822), not shares + fees (1,005)", async () => {
    m.chunked.mockResolvedValueOnce([registry(1)]);
    m.pricing.mockResolvedValue(LOSS);
    const { data, ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(data[SLAB]).toEqual({ tvlAtoms: 822_000_000n, cooldownSlots: 150n, found: true });
    expect(m.pricing.mock.calls[0][2].toBase58()).toBe(SLAB);
  });

  it("unpriceable this cycle: unvalued (left out of TVL by name), never shares + fees", async () => {
    m.chunked.mockResolvedValueOnce([registry(1)]);
    m.pricing.mockResolvedValue(null);
    const { data } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(data[SLAB]).toMatchObject({ tvlAtoms: 0n, found: true, unvalued: true });
  });

  it("no shares outstanding: 0", async () => {
    m.chunked.mockResolvedValueOnce([registry(1)]);
    m.pricing.mockResolvedValue({ totalShares: 0n, withdrawSeniorValue: null });
    const { data } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(data[SLAB]).toEqual({ tvlAtoms: 0n, cooldownSlots: 150n, found: true });
  });

  it("CONTROL: a legacy registry is not priced this way (shares + fees, as the program pays)", async () => {
    m.chunked.mockResolvedValueOnce([{ ...registry(0), data: Buffer.alloc(8) }]);
    const { data } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(m.pricing).not.toHaveBeenCalled();
    expect(data[SLAB].tvlAtoms).toBe(1_005_000_000n);
  });
});

describe("hub table Your Value (readEarnPositions), bound vault", () => {
  const conn = (reg: ReturnType<typeof registry>) => ({ getMultipleAccountsInfo: vi.fn(async () => [tokenAcct(100_000_000n), null, reg]) });

  it("after a loss: floor(shares * senior / S) = the withdraw preview (82.2), not 100.5", async () => {
    m.pricing.mockResolvedValue(LOSS);
    const out = await readEarnPositions(conn(registry(1)) as never, PROG, WALLET, [SLAB]);
    expect(out.get(SLAB)).toEqual({ shares: 100_000_000n, valueAtoms: 82_200_000n });
  });

  it("unpriceable: unknown (null)", async () => {
    m.pricing.mockResolvedValue({ totalShares: 1_000_000_000n, withdrawSeniorValue: null });
    const out = await readEarnPositions(conn(registry(1)) as never, PROG, WALLET, [SLAB]);
    expect(out.get(SLAB)).toEqual({ shares: 100_000_000n, valueAtoms: null });
  });
});
