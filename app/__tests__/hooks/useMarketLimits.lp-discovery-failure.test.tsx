/**
 * E2E B17: LP discovery (a program scan on a public RPC) failing must NOT hide the P3 vault
 * state / registry the tranche card needs.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "@/lib/limits/constants";
import { useMarketLimits } from "@/hooks/useMarketLimits";

const layouts = JSON.parse(readFileSync(join(__dirname, "../fixtures/limits/rust-layouts.json"), "utf8")) as { vaultLpStateHex: string };
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

const vaultAcct = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
vaultAcct[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
vaultAcct.set(hex(layouts.vaultLpStateHex), C.HEADER_LEN);
const registryAcct = new Uint8Array(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
registryAcct[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
new DataView(registryAcct.buffer).setBigUint64(C.REG_TOTAL_LP_SHARES_OUTSTANDING, 1_000n, true);

vi.mock("@/lib/limits/flags", async (orig) => ({ ...((await orig()) as object), limitsFlags: () => ({ p1: false, p2: false, p2FeeCharged: false, p3: true }) }));
vi.mock("@/lib/limits/lp-discovery", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const vaultPda = Keypair.generate().publicKey;
  const regPda = Keypair.generate().publicKey;
  return {
    resolveLpAccounts: vi.fn(async () => {
      throw new Error("getProgramAccounts: 429 / disabled on this RPC");
    }),
    // PDA derivation is not under test (and trips jsdom's cross-realm Uint8Array in web3).
    deriveVaultLpStatePda: (_p: unknown, _m: unknown, seed: string) => (seed === "vault_lp" ? vaultPda : regPda),
  };
});
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => undefined }));
// A STABLE connection object (the hook's effect depends on it, as with the real provider).
const stableConnection = { getMultipleAccountsInfo: vi.fn(async () => [{ data: vaultAcct }, { data: registryAcct }]) };
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: stableConnection }) }));
vi.mock("@/components/providers/SlabProvider", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return { useSlabState: () => ({ raw: null, programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"), assetProfile: null }) };
});

describe("useMarketLimits with a failing LP discovery", () => {
  it("still reads the vault-LP state and the registry share count", async () => {
    const { result } = renderHook(() => useMarketLimits("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr"));
    await waitFor(() => expect(result.current.vaultState).not.toBeNull());
    expect(result.current.registryShares).toBe(1_000n);
    expect(result.current.lp).toBeNull();
  });
});
