import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import type { EarnV22Context } from "@/lib/v22/earn-context";

const m = vi.hoisted(() => ({ conn: { getMultipleAccountsInfo: vi.fn().mockResolvedValue([null]), getSlot: vi.fn().mockResolvedValue(1) } }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: m.conn }), useWalletCompat: () => ({ publicKey: null }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => 10n }));
vi.mock("@/lib/v22/sdk", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/sdk")>();
  const fixed = (await import("@solana/web3.js")).Keypair.generate().publicKey;
  return { ...real, deriveBondTrancheV22: () => [fixed, 255], deriveBondPositionV22: () => [fixed, 255] };
});
import { useBondV22 } from "@/hooks/useBondV22";

const k = () => Keypair.generate().publicKey;
const ctx: EarnV22Context = { market: k(), programId: k(), collateralMint: k(), decimals: 6, symbol: "X", registryDomain: 0, lpPortfolio: null, view: null, registryShares: null, oiLongQ: 0n, oiShortQ: 0n, lpEffAbsQ: 0n };
afterEach(() => __setDevnetV22ForTest(null));

describe("useBondV22", () => {
  it("flag off: no RPC, no bond", async () => {
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useBondV22(ctx));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.bond).toBeNull();
    expect(m.conn.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it("flag on and no tranche account: bond stays null (no surface)", async () => {
    __setDevnetV22ForTest(true);
    const { result } = renderHook(() => useBondV22(ctx));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.conn.getMultipleAccountsInfo).toHaveBeenCalled();
    expect(result.current.bond).toBeNull();
  });
});
