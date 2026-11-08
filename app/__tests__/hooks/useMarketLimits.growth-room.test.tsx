/**
 * M9 (round 4): the hook WIRING of `growthRoom` (not just the pure helper): emitted only on a v2.1+v2.2 build, "loading" before any read,
 * and "error" once a completed read found no usable LP (discovery failed), so the ticket can say "unavailable" instead of "Checking room…" forever.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

vi.mock("@/lib/limits/flags", async (orig) => ({ ...((await orig()) as object), limitsFlags: () => ({ p1: false, p2: false, p2FeeCharged: false, p3: false }) }));
vi.mock("@/lib/limits/lp-discovery", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const pda = Keypair.generate().publicKey;
  return {
    resolveLpAccounts: vi.fn(async () => { throw new Error("getProgramAccounts: 429"); }),
    deriveVaultLpStatePda: () => pda, // a v2.2 build also reads the Earn vault state
  };
});
// An underivable guard address is skipped by the hook (no guard quote); keeps this a COMPLETED read with no thrown error (jsdom cross-realm bytes trip web3 PDA derivation).
vi.mock("@/lib/v22/lev-guard", async (orig) => ({ ...((await orig()) as object), levGuardPda: () => { throw new Error("skip"); } }));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => undefined }));
const stableConnection = { getMultipleAccountsInfo: vi.fn(async () => []) };
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: stableConnection }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => null }));
vi.mock("@/components/providers/SlabProvider", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return { useSlabState: () => ({ raw: null, programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"), assetProfile: null }) };
});

const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
afterEach(() => { __setDevnetV21ForTest(null); __setDevnetV22ForTest(null); });

describe("useMarketLimits growthRoom wiring", () => {
  it("v2.1 + v2.2 build: 'loading' on the first render, 'error' after a completed read with no LP", async () => {
    __setDevnetV21ForTest(true); __setDevnetV22ForTest(true);
    const { useMarketLimits } = await import("@/hooks/useMarketLimits");
    const { result } = renderHook(() => useMarketLimits(SLAB));
    expect(result.current.growthRoom).toBe("loading");
    await waitFor(() => expect(result.current.growthRoom).toBe("error"));
  });
  it("not emitted without v2.2 (legacy / v2.1-only builds are unchanged)", async () => {
    __setDevnetV21ForTest(true); __setDevnetV22ForTest(false);
    const { useMarketLimits } = await import("@/hooks/useMarketLimits");
    const { result } = renderHook(() => useMarketLimits(SLAB));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.growthRoom).toBeUndefined();
  });
});
