// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reads: 0,
  failNext: 0,
  gate: null as Promise<void> | null,
  row: null as null | {
    slab_address: string;
    dex_pool_address: string;
  },
}));

vi.mock("@/lib/supabase", () => {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    abortSignal: () => query,

    limit: async () => {
      h.reads++;

      if (h.gate) await h.gate;

      if (h.failNext > 0) {
        h.failNext--;
        return {
          data: null,
          error: { message: "simulated DB failure" },
        };
      }

      return {
        data: h.row ? [h.row] : [],
        error: null,
      };
    },
  };

  return {
    getServerNetwork: () => "devnet",
    getServiceClient: () => ({
      from: () => query,
    }),
  };
});

vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async () => [],
}));

import {
  registeredPoolForMint,
  __clearRegisteredPoolCache,
} from "@/lib/registered-pool";

const MINT =
  "9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj";

const SLAB =
  "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";

const POOL =
  "21bzHy2kRoVKgtYZ8hFoetki2134MG2jyWGC49UV5pyi";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

  h.reads = 0;
  h.failNext = 0;
  h.gate = null;
  h.row = {
    slab_address: SLAB,
    dex_pool_address: POOL,
  };

  __clearRegisteredPoolCache();
});

describe("V22 PR-B isolated single-flight", () => {
  it("16 concurrent requests share one DB lookup", async () => {
    let release = () => {};

    h.gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const tasks = Array.from(
      { length: 16 },
      () => registeredPoolForMint(MINT)
    );

    let results: Awaited<typeof tasks[number]>[] = [];

    try {
      expect(h.reads).toBe(1);
    } finally {
      release();
      results = await Promise.all(tasks);
      h.gate = null;
    }

    expect(results).toHaveLength(16);
    expect(results.every(r => r?.pool === POOL)).toBe(true);
    expect(h.reads).toBe(1);

    console.log("ISOLATED_CONCURRENT_REQUESTS=16");
    console.log("ISOLATED_DB_READS=1");
    console.log("PR_B_SINGLEFLIGHT=PASS");
  });

  it("failed lookup releases the slot and permits retry", async () => {
    h.failNext = 1;

    const results = await Promise.allSettled(
      Array.from(
        { length: 16 },
        () => registeredPoolForMint(MINT)
      )
    );

    expect(results.every(r => r.status === "rejected"))
      .toBe(true);

    expect(h.reads).toBe(1);

    const retry = await registeredPoolForMint(MINT);

    expect(retry?.pool).toBe(POOL);
    expect(h.reads).toBe(2);

    console.log("PR_B_FAILURE_COALESCED=PASS");
    console.log("PR_B_RETRY_RECOVERY=PASS");
  });
});
