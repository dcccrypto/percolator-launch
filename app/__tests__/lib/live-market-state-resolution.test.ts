// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";

import {
  readLiveMarketStateResolutions,
} from "@/lib/live-market-state";

const SLAB =
  "AcaTmUFncaVEBCvUoR57yWUseJgonUvanWHGYxmXok18";

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
        [SLAB],
        connection(async () => [null]),
      );

    expect(result.states.has(SLAB)).toBe(false);
    expect(result.missing.has(SLAB)).toBe(true);
    expect(result.unresolved.has(SLAB)).toBe(false);
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
        [SLAB, otherSlab],
        connection(async () => [null]),
      );

    expect(result.missing.has(SLAB)).toBe(true);
    expect(result.missing.has(otherSlab)).toBe(false);
    expect(result.unresolved.has(otherSlab)).toBe(true);
  });
});
