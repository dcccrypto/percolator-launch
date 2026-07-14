/**
 * G/H/I: getMultipleAccountsInfoChunked — Solana's getMultipleAccounts RPC
 * caps at 100 pubkeys per call and @solana/web3.js does NOT chunk internally.
 * Unbounded key arrays built from curated ∪ user-registered markets/pools
 * (useLpPositions.ts, app/api/stake/pools/route.ts, useEarnStats.ts) used to
 * call connection.getMultipleAccountsInfo directly and throw once that union
 * crossed 100 keys — bricking LP positions / the whole /stake route / Earn
 * TVL for everyone. See lib/rpc-chunk.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { getMultipleAccountsInfoChunked, MAX_ACCOUNTS_PER_RPC_CALL } from "@/lib/rpc-chunk";

/** A fake Connection whose getMultipleAccountsInfo enforces the real RPC's
 *  100-key cap — mirrors what a live Solana RPC node would do. */
function makeFakeConnection() {
  const calls: number[] = [];
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => {
    if (keys.length > 100) {
      throw new Error("failed to get multiple accounts: Too many inputs provided");
    }
    calls.push(keys.length);
    return keys.map((k) => ({
      executable: false,
      owner: k,
      lamports: 1,
      data: Buffer.from([1]),
      rentEpoch: 0,
    }));
  });
  return { getMultipleAccountsInfo, calls } as unknown as {
    getMultipleAccountsInfo: typeof getMultipleAccountsInfo;
    calls: number[];
  };
}

function makeKeys(n: number): PublicKey[] {
  return Array.from({ length: n }, () => PublicKey.unique());
}

describe("getMultipleAccountsInfoChunked", () => {
  it("passes an under-cap array straight through in ONE call", async () => {
    const conn = makeFakeConnection();
    const keys = makeKeys(50);
    const result = await getMultipleAccountsInfoChunked(conn as any, keys);
    expect(result).toHaveLength(50);
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });

  it("does not throw for exactly 100 keys (the real RPC cap)", async () => {
    const conn = makeFakeConnection();
    const keys = makeKeys(MAX_ACCOUNTS_PER_RPC_CALL);
    const result = await getMultipleAccountsInfoChunked(conn as any, keys);
    expect(result).toHaveLength(100);
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });

  it("chunks 101+ keys into multiple <=100 batches instead of throwing", async () => {
    const conn = makeFakeConnection();
    // Mirrors the real-world overflow: 6 curated + up to 100 registered
    // markets/pools (useEarnStats.ts / stake pools route / useLpPositions.ts).
    const keys = makeKeys(106);
    const result = await getMultipleAccountsInfoChunked(conn as any, keys);
    expect(result).toHaveLength(106);
    // 2 calls: 100 + 6 — never a single >100-key call.
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    for (const call of conn.getMultipleAccountsInfo.mock.calls) {
      expect((call[0] as PublicKey[]).length).toBeLessThanOrEqual(100);
    }
  });

  it("preserves index-alignment with the input across a chunk boundary", async () => {
    const conn = makeFakeConnection();
    const keys = makeKeys(210); // 2×pools.length worst case from useLpPositions.ts
    const result = await getMultipleAccountsInfoChunked(conn as any, keys);
    expect(result).toHaveLength(210);
    result.forEach((info, i) => {
      // The fake connection echoes each key back as `owner` — confirms the
      // flattened result lines up 1:1 with the original `keys` order.
      expect((info as any).owner.equals(keys[i])).toBe(true);
    });
  });

  it("short-circuits an empty array without a network round-trip", async () => {
    const conn = makeFakeConnection();
    const result = await getMultipleAccountsInfoChunked(conn as any, []);
    expect(result).toEqual([]);
    expect(conn.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("forwards the commitment/config argument to every chunk", async () => {
    const conn = makeFakeConnection();
    const keys = makeKeys(150);
    await getMultipleAccountsInfoChunked(conn as any, keys, "confirmed");
    for (const call of conn.getMultipleAccountsInfo.mock.calls) {
      expect(call[1]).toBe("confirmed");
    }
  });
});
