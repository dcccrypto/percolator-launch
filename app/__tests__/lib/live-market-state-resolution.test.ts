// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";

import {
  readLiveMarketStateResolutions,
  readSlabExistence,
} from "@/lib/live-market-state";

// Fixture only. This is the mistyped BURNIE address from issue #2988 (the real, live slab is
// AcaTmUFncavEBcvUoR57yWU5eJgonUvanWHGYxmXok18); it is used here as "an address with no account".
const SLAB =
  "AcaTmUFncaVEBCvUoR57yWUseJgonUvanWHGYxmXok18";
// A second slab that exists on-chain in these fixtures. A null only counts as "missing" when at
// least one requested account exists (wrong-cluster guard), so the positive controls need it.
const EXISTING =
  "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg";
const EXISTING_INFO = { data: Buffer.from([1, 2, 3, 4]) };

function connection(
  impl: () => Promise<unknown>,
): Connection {
  return {
    getMultipleAccountsInfo: vi.fn(impl),
  } as unknown as Connection;
}

describe("readLiveMarketStateResolutions", () => {
  it("POSITIVE CONTROL: explicit RPC null is confirmed missing", async () => {
    const result =
      await readLiveMarketStateResolutions(
        [SLAB, EXISTING],
        connection(async () => [null, EXISTING_INFO]),
      );

    expect(result.states.has(SLAB)).toBe(false);
    expect(result.missing.has(SLAB)).toBe(true);
    expect(result.unresolved.has(SLAB)).toBe(false);
    // The existing-but-unparseable slab is unresolved, never missing.
    expect(result.missing.has(EXISTING)).toBe(false);
    expect(result.unresolved.has(EXISTING)).toBe(true);
  });

  it("NEGATIVE CONTROL: RPC failure is unresolved, not missing", async () => {
    const result =
      await readLiveMarketStateResolutions(
        [SLAB],
        connection(async () => {
          throw new Error("synthetic RPC failure");
        }),
      );

    expect(result.states.has(SLAB)).toBe(false);
    expect(result.missing.has(SLAB)).toBe(false);
    expect(result.unresolved.has(SLAB)).toBe(true);
  });

  it("NEGATIVE CONTROL: existing unreadable bytes are unresolved, not missing", async () => {
    const result =
      await readLiveMarketStateResolutions(
        [SLAB],
        connection(async () => [
          {
            data: Buffer.from([1, 2, 3, 4]),
          },
        ]),
      );

    expect(result.states.has(SLAB)).toBe(false);
    expect(result.missing.has(SLAB)).toBe(false);
    expect(result.unresolved.has(SLAB)).toBe(true);
  });

  it("NEGATIVE CONTROL: malformed registry address is unresolved without RPC", async () => {
    const rpc = vi.fn();

    const result =
      await readLiveMarketStateResolutions(
        ["not-a-public-key"],
        {
          getMultipleAccountsInfo: rpc,
        } as unknown as Connection,
      );

    expect(result.missing.size).toBe(0);
    expect(
      result.unresolved.has("not-a-public-key"),
    ).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: a short RPC result is unresolved rather than missing", async () => {
    const otherSlab =
      "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy";

    const result =
      await readLiveMarketStateResolutions(
        [EXISTING, SLAB, otherSlab],
        connection(async () => [EXISTING_INFO, null]),
      );

    expect(result.missing.has(SLAB)).toBe(true);
    expect(result.missing.has(otherSlab)).toBe(false);
    expect(result.unresolved.has(otherSlab)).toBe(true);
  });

  it("NEGATIVE CONTROL (wrong-cluster guard): when NO requested account exists, nulls are unresolved", async () => {
    const otherSlab =
      "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy";

    // e.g. DEVNET_RPC_URL pointed at mainnet: every slab comes back null.
    const result =
      await readLiveMarketStateResolutions(
        [SLAB, otherSlab, EXISTING],
        connection(async () => [null, null, null]),
      );

    expect(result.missing.size).toBe(0);
    expect([...result.unresolved].sort()).toEqual(
      [SLAB, otherSlab, EXISTING].sort(),
    );
  });

  it("wrong-cluster guard spans chunks: an existing account in a later chunk still proves the nulls", async () => {
    // 101 distinct valid pubkeys → two getMultipleAccountsInfo calls (CHUNK = 100).
    const { Keypair } = await import("@solana/web3.js");
    const slabs = Array.from({ length: 101 }, () =>
      Keypair.generate().publicKey.toBase58(),
    );
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(slabs.slice(0, 100).map(() => null))
      .mockResolvedValueOnce([EXISTING_INFO]);

    const result = await readLiveMarketStateResolutions(slabs, {
      getMultipleAccountsInfo: rpc,
    } as unknown as Connection);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result.missing.size).toBe(100);
    expect(result.unresolved.has(slabs[100])).toBe(true);
  });
});

describe("multi-chunk RPC failure (the real exposure for the never-hide-on-RPC-failure property)", () => {
  // 101 slabs = 2 chunks (CHUNK = 100). Chunk 1 succeeds (accounts exist, so the wrong-cluster guard
  // cannot rescue anything); chunk 2 rejects like a 429. A single failing chunk would be rescued by
  // the guard and prove nothing, so these two tests are the independent control for that handler.
  it("readLiveMarketStateResolutions: a rejected second chunk is unresolved, never missing", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const slabs = Array.from({ length: 101 }, () => Keypair.generate().publicKey.toBase58());
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(slabs.slice(0, 100).map(() => EXISTING_INFO))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const r = await readLiveMarketStateResolutions(slabs, { getMultipleAccountsInfo: rpc } as unknown as Connection);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(r.missing.size).toBe(0);
    expect(r.unresolved.has(slabs[100])).toBe(true);
  });

  it("readSlabExistence: a rejected second chunk is unresolved, never missing", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const slabs = Array.from({ length: 101 }, () => Keypair.generate().publicKey.toBase58());
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(slabs.slice(0, 100).map(() => EXISTING_INFO))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const r = await readSlabExistence(slabs, { getMultipleAccountsInfo: rpc } as unknown as Connection);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(r.missing.size).toBe(0);
    expect(r.unresolved.has(slabs[100])).toBe(true);
  });
});

describe("readSlabExistence", () => {
  it("asks for a 17-byte dataSlice (header + 1) and treats any non-tombstone account as existing", async () => {
    const rpc = vi.fn(async () => [
      null,
      { data: Buffer.alloc(0) },
    ]);

    const result = await readSlabExistence([SLAB, EXISTING], {
      getMultipleAccountsInfo: rpc,
    } as unknown as Connection);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0] as unknown[])[1]).toEqual({
      dataSlice: { offset: 0, length: 17 },
    });
    expect([...result.missing]).toEqual([SLAB]);
    // An existing account that is not the tombstone is neither missing nor unresolved.
    expect(result.unresolved.size).toBe(0);
  });

  it("NEGATIVE CONTROL: an RPC failure hides nothing", async () => {
    const result = await readSlabExistence(
      [SLAB, EXISTING],
      connection(async () => {
        throw new Error("synthetic RPC failure");
      }),
    );

    expect(result.missing.size).toBe(0);
    expect(result.unresolved.size).toBe(2);
  });

  it("NEGATIVE CONTROL (wrong-cluster guard): all-null reply hides nothing", async () => {
    const result = await readSlabExistence(
      [SLAB, EXISTING],
      connection(async () => [null, null]),
    );

    expect(result.missing.size).toBe(0);
    expect(result.unresolved.size).toBe(2);
  });
});
