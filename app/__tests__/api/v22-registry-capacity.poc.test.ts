// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  calls: 0,
  gate: null as Promise<void> | null,
}));

vi.mock("@/lib/supabase", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    abortSignal: () => chain,
    limit: async () => {
      h.calls++;
      if (h.gate) await h.gate;
      return { data: [], error: null };
    },
  };

  return {
    getServerNetwork: () => "devnet",
    getServiceClient: () => ({
      from: () => chain,
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

function mint(i: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = 9;
  bytes[30] = (i >> 8) & 255;
  bytes[31] = i & 255;
  return new PublicKey(bytes).toBase58();
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  h.calls = 0;
  h.gate = null;
  __clearRegisteredPoolCache();
});

describe("V22 registered pool lookup capacity", () => {
  it("limits distinct active lookups to 64 and recovers", async () => {
    let release = () => {};

    const gate = new Promise<void>(resolve => {
      release = () => resolve();
    });

    h.gate = gate;

    const tasks = Array.from(
      { length: 64 },
      (_, i) => registeredPoolForMint(mint(i + 100))
    );

    try {
      expect(h.calls).toBe(64);

      // The 65th distinct lookup must be rejected.
      await expect(
        registeredPoolForMint(mint(200))
      ).rejects.toThrow(/registered pool lookup failed/);

      expect(h.calls).toBe(64);

      console.log("ACTIVE_LOOKUP_LIMIT=64");
      console.log("EXCESS_LOOKUP_REJECTED=PASS");
    } finally {
      release();
      await Promise.allSettled(tasks);
      h.gate = null;
    }

    // Completed requests must release capacity.
    await registeredPoolForMint(mint(300));

    expect(h.calls).toBe(65);

    console.log("CAPACITY_RECOVERY=PASS");
  });
});
