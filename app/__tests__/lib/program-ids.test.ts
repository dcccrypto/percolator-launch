// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { PROGRAM_IDS, PROGRAM_IDS_V17 } from "@percolatorct/sdk";
import { DEVNET_PROGRAM_IDS, DEVNET_V22_PROGRAM_IDS, MAINNET_PROGRAM_IDS, parseProgramIdOverride, resolveDevnetProgramIds } from "@/lib/program-ids";

describe("program-ids: the single repoint point", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("agrees with the installed SDK's default devnet ids (fails on an SDK bump without the repoint, or vice versa)", () => {
    expect(DEVNET_PROGRAM_IDS.wrapper).toBe(PROGRAM_IDS.devnet.percolator);
    expect(DEVNET_PROGRAM_IDS.matcher).toBe(PROGRAM_IDS.devnet.matcher);
    expect(DEVNET_PROGRAM_IDS.nft).toBe(PROGRAM_IDS_V17.nft);
    expect(DEVNET_PROGRAM_IDS.stake).toBe(PROGRAM_IDS_V17.vault);
    expect(MAINNET_PROGRAM_IDS.wrapper).toBe(PROGRAM_IDS.mainnet.percolator);
  });

  it("config reads program-ids: programId, every slab tier, and the allowlist move together", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    const {
      getConfig,
      getAllProgramIds,
      getMarketDiscoveryProgramIds,
    } = await import("@/lib/config");
    const cfg = getConfig();
    expect(cfg.programId).toBe(DEVNET_PROGRAM_IDS.wrapper);
    expect(Object.values(cfg.programsBySlabTier ?? {})).toEqual([
      DEVNET_PROGRAM_IDS.wrapper, DEVNET_PROGRAM_IDS.wrapper, DEVNET_PROGRAM_IDS.wrapper,
    ]);

    // Security allowlist keeps every deployed Percolator program.
    expect(new Set(getAllProgramIds())).toEqual(
      new Set(Object.values(DEVNET_PROGRAM_IDS)),
    );

    // Market discovery is deliberately narrower: matcher/NFT/stake do not
    // own v17 market accounts and must not be queried as market directories.
    expect(getMarketDiscoveryProgramIds()).toEqual([
      DEVNET_PROGRAM_IDS.wrapper,
    ]);
  });

  it("env override repoints the wrapper everywhere on a devnet build (E2E / local fork)", async () => {
    const forkId = "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy";
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", forkId);
    vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
    const { getConfig, getAllProgramIds } = await import("@/lib/config");
    expect(getConfig().programId).toBe(forkId);
    expect(getAllProgramIds()).toContain(forkId);
    // NEGATIVE CONTROL: the replaced wrapper is no longer trusted
    expect(getAllProgramIds()).not.toContain(DEVNET_PROGRAM_IDS.wrapper);
  });

  it("NEGATIVE CONTROL: an override without the explicit opt-in is ignored", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy");
    expect(resolveDevnetProgramIds().wrapper).toBe(DEVNET_PROGRAM_IDS.wrapper);
    vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
    expect(resolveDevnetProgramIds().wrapper).toBe("4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy");
  });

  it("NEGATIVE CONTROL: overrides are ignored on a mainnet build", () => {
    vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy");
    expect(resolveDevnetProgramIds().wrapper).toBe(DEVNET_PROGRAM_IDS.wrapper);
  });

  it("NEGATIVE CONTROL: an invalid override is ignored", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", "not-a-key");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDevnetProgramIds().wrapper).toBe(DEVNET_PROGRAM_IDS.wrapper);
    expect(warn).toHaveBeenCalled();
    expect(parseProgramIdOverride("X", "")).toBeNull();
    expect(parseProgramIdOverride("X", undefined)).toBeNull();
  });

  it("QA E2E-1: a v2.2 build defaults to the v2.2 set (nft 27LWmR72, the id wrapper 6kpg2wi7 pins), with no env override", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
    expect(resolveDevnetProgramIds()).toEqual({ ...DEVNET_V22_PROGRAM_IDS });
    expect(DEVNET_V22_PROGRAM_IDS).toEqual({
      wrapper: "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM",
      matcher: "AsHvEJ8zNctKmdeS57H5E4w6nkTLi3bPVpd6ZCLc2ayN",
      nft: "27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1",
      stake: "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V",
    });
    // The create wizard's SetNftProgramId (M1) carries the same id.
    const { PERCOLATOR_NFT_PROGRAM_ID } = await import("@/lib/nft-program");
    expect(PERCOLATOR_NFT_PROGRAM_ID.toBase58()).toBe("27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1");
    const { getConfig } = await import("@/lib/config");
    expect(getConfig().programId).toBe(DEVNET_V22_PROGRAM_IDS.wrapper);
  });

  it("QA E2E-1: on a v2.2 build an opted-in override still wins, per program", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
    vi.stubEnv("NEXT_PUBLIC_NFT_PROGRAM_ID", "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy");
    expect(resolveDevnetProgramIds()).toEqual({ ...DEVNET_V22_PROGRAM_IDS, nft: "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy" });
  });

  it("NEGATIVE CONTROL (E2E-1): flag off keeps the live v2 set (EMYT15LZ pairs with ETDLAdi); mainnet ignores the flag", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    expect(resolveDevnetProgramIds()).toEqual({ ...DEVNET_PROGRAM_IDS });
    expect(resolveDevnetProgramIds().nft).toBe("EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ");
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    expect(resolveDevnetProgramIds()).toEqual({ ...DEVNET_PROGRAM_IDS });
  });

  it("NEXT_PUBLIC_PROGRAM_ID (the old, unset-on-Vercel var) no longer affects anything", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_PROGRAM_ID", "5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
    const { getAllProgramIds } = await import("@/lib/config");
    expect(getAllProgramIds()).not.toContain("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  });
});
