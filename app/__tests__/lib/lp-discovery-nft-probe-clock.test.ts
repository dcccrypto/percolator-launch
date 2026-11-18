// @vitest-environment node
/**
 * A backwards wall-clock step (NTP/VM resume) made `Date.now() - ts` negative, so
 * `age < TTL` stayed true and the LP-discovery / NFT deploy-slot probe caches were
 * served as fresh until the clock caught up. A future-stamped entry must be a miss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

vi.mock("@/lib/program-ids", async (orig) => ({
  ...((await orig()) as object),
  nftS12Deploy: () => ({ deployed: false, minDeploySlot: 100 }),
}));

import { resolveLpAccounts } from "@/lib/limits/lp-discovery";
import { resolveNftLegacyIsStale, resetNftIncarnationCache } from "@/lib/nft-incarnation";

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetNftIncarnationCache();
});
afterEach(() => vi.useRealTimers());

describe("lp-discovery cache vs backwards clock", () => {
  it("re-resolves after the clock steps back past the TTL window", async () => {
    const lp = Keypair.generate().publicKey;
    const getAccountInfo = vi.fn(async () => ({ data: Buffer.alloc(8) }));
    const conn = { getAccountInfo } as never;
    const programId = Keypair.generate().publicKey;
    const slab = Keypair.generate().publicKey;
    await resolveLpAccounts(conn, programId, slab, lp);
    await resolveLpAccounts(conn, programId, slab, lp);
    expect(getAccountInfo).toHaveBeenCalledTimes(1); // normal hit
    vi.setSystemTime(T0 - 3_600_000); // clock steps back 1h
    await resolveLpAccounts(conn, programId, slab, lp);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });
});

describe("nft-incarnation probe cache vs backwards clock", () => {
  it("re-probes after the clock steps back", async () => {
    const getAccountInfo = vi.fn(async () => null);
    const conn = { getAccountInfo } as never;
    const nft = new PublicKey("11111111111111111111111111111112");
    await resolveNftLegacyIsStale(conn, nft);
    await resolveNftLegacyIsStale(conn, nft);
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 - 3_600_000);
    await resolveNftLegacyIsStale(conn, nft);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });
});
