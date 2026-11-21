// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbReads: 0,
  blobReads: 0,
  abortCalls: 0,
  hangBlob: false,
  releaseBlob: null as null | (() => void),
}));

vi.mock("@/lib/supabase", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    abortSignal: () => chain,
    limit: async () => {
      h.dbReads++;
      return {
        data: [{
          slab_address: "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx",
          dex_pool_address: "21bzHy2kRoVKgtYZ8hFoetki2134MG2jyWGC49UV5pyi",
        }],
        error: null,
      };
    },
  };

  return {
    getServerNetwork: () => "devnet",
    getServiceClient: () => ({ from: () => chain }),
  };
});

vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async (signal?: AbortSignal) => {
    h.blobReads++;

    if (!h.hangBlob) return [];

    return new Promise<[]>((resolve, reject) => {
      h.releaseBlob = () => resolve([]);

      const abort = () => {
        h.abortCalls++;
        reject(new Error("blob request aborted"));
      };

      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  },
}));

import {
  registeredPoolForMint,
  __clearRegisteredPoolCache,
} from "@/lib/registered-pool";

const MINT =
  "9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

  h.dbReads = 0;
  h.blobReads = 0;
  h.abortCalls = 0;
  h.hangBlob = false;
  h.releaseBlob = null;

  __clearRegisteredPoolCache();
});

describe("V22 registry Blob timeout", () => {
  it("CONTROL: normal Blob lookup completes", async () => {
    const result = await registeredPoolForMint(MINT);

    expect(result?.pool).toBe(
      "21bzHy2kRoVKgtYZ8hFoetki2134MG2jyWGC49UV5pyi"
    );

    expect(h.dbReads).toBe(1);
    expect(h.blobReads).toBe(1);

    console.log("BLOB_NORMAL_CONTROL=PASS");
  });

  it("REGRESSION: a hung Blob read must not hold the lookup forever", async () => {
    h.hangBlob = true;
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);

    const request = registeredPoolForMint(MINT);

    await vi.waitFor(() => {
      expect(h.blobReads).toBe(1);
    });

    controller.abort();

    let watchdog: ReturnType<typeof setTimeout> | undefined;

    let outcome = "unknown";

    try {
      outcome = await Promise.race([
        request.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>(resolve => {
          watchdog = setTimeout(() => resolve("hung"), 250);
        }),
      ]);
    } finally {
      if (watchdog) clearTimeout(watchdog);

      // Release the mock so the test leaves no pending work.
      h.releaseBlob?.();
      await Promise.allSettled([request]);
      timeoutSpy.mockRestore();
    }

    console.log(`BLOB_TIMEOUT_OBSERVATION=${outcome}`);
    console.log(`BLOB_DB_READS=${h.dbReads}`);
    console.log(`BLOB_READS=${h.blobReads}`);

    expect(outcome).toBe("resolved");
    expect(h.abortCalls).toBe(1);
    console.log("BLOB_ABORT_PROPAGATED=PASS");
  });
});
