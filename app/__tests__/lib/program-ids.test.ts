// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { PROGRAM_IDS, PROGRAM_IDS_V17 } from "@percolatorct/sdk";
import { DEVNET_PROGRAM_IDS, MAINNET_PROGRAM_IDS, parseProgramIdOverride, resolveDevnetProgramIds } from "@/lib/program-ids";

describe("program-ids: the single repoint point", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("pins the v2.2 11-06 devnet set; mainnet IDs still match the installed SDK", () => {
    // Devnet defaults in published @percolatorct/sdk@8.0.0 are still the older
    // set; launch is the authority until the companion SDK PR is published.
    expect(DEVNET_PROGRAM_IDS).toEqual({
      wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
      matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
      nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
      stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
    });
    expect(MAINNET_PROGRAM_IDS.wrapper).toBe(PROGRAM_IDS.mainnet.percolator);
    expect(MAINNET_PROGRAM_IDS.matcher).toBe(PROGRAM_IDS.mainnet.matcher);
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

  it("NEXT_PUBLIC_PROGRAM_ID (the old, unset-on-Vercel var) no longer affects anything", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_PROGRAM_ID", "5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
    const { getAllProgramIds } = await import("@/lib/config");
    expect(getAllProgramIds()).not.toContain("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  });
});
