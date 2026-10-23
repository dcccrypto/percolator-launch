// @vitest-environment node
/**
 * Copy QA item 10: a deployment whose collateral is a fresh sim-USDC mint (NEXT_PUBLIC_TEST_USDC_MINT) showed the truncated mint on
 * the portfolio cards, because only the old hard-coded devnet mint was a known token. The env mint is known now, with no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("fetchTokenMetaBatch: the configured sim-USDC mint is USDC", () => {
  it("resolves the env mint to USDC / 6 decimals without any lookup", async () => {
    const mint = Keypair.generate().publicKey;
    vi.stubEnv("NEXT_PUBLIC_TEST_USDC_MINT", mint.toBase58());
    vi.resetModules();
    const { fetchTokenMetaBatch } = await import("@/lib/tokenMeta");
    const connection = { getMultipleAccountsInfo: vi.fn(async () => { throw new Error("no RPC expected"); }) } as never;
    const m = await fetchTokenMetaBatch(connection, [mint]);
    expect(m.get(mint.toBase58())).toMatchObject({ symbol: "USDC", decimals: 6 });
    expect(m.get(mint.toBase58())!.symbol).not.toContain("...");
  });
  it("negative control: without the env entry the same unknown mint is NOT claimed to be USDC", async () => {
    const mint = Keypair.generate().publicKey;
    vi.stubEnv("NEXT_PUBLIC_TEST_USDC_MINT", "");
    vi.resetModules();
    const { fetchTokenMetaBatch } = await import("@/lib/tokenMeta");
    const connection = { getMultipleAccountsInfo: vi.fn(async () => [null]) , getAccountInfo: vi.fn(async () => null) } as never;
    const m = await fetchTokenMetaBatch(connection, [mint]).catch(() => new Map());
    expect(m.get(mint.toBase58())?.symbol).not.toBe("USDC");
  });
});
