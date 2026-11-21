// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reads: 0,
  abortCalls: 0,
  hang: true,
  signal: null as AbortSignal | null,
  release: null as null | (() => void),
}));

vi.mock("@/lib/supabase", () => {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,

    abortSignal: (signal: AbortSignal) => {
      h.abortCalls++;
      h.signal = signal;
      return query;
    },

    limit: async () => {
      h.reads++;

      const signal = h.signal;
      h.signal = null;

      if (!h.hang) {
        return { data: [], error: null };
      }

      return new Promise(resolve => {
        const finish = (result: unknown) => resolve(result);

        h.release = () =>
          finish({ data: [], error: null });

        if (signal?.aborted) {
          finish({ data: null, error: { message: "aborted" } });
        } else {
          signal?.addEventListener(
            "abort",
            () => finish({
              data: null,
              error: { message: "aborted" },
            }),
            { once: true },
          );
        }
      });
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

describe("V22 hung registry lookup", () => {
  it("REGRESSION: aborts a hung DB request and allows retry", async () => {
    __clearRegisteredPoolCache();

    h.reads = 0;
    h.abortCalls = 0;
    h.hang = true;
    h.signal = null;
    h.release = null;

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

    const controller = new AbortController();

    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);

    let timer: ReturnType<typeof setTimeout> | undefined;

    const request = registeredPoolForMint(MINT);
    let outcome = "unknown";

    try {
      controller.abort();

      outcome = await Promise.race([
        request.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>(resolve => {
          timer = setTimeout(() => resolve("hung"), 250);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);

      // Always release the mock even if the assertion will fail.
      h.release?.();
      await Promise.allSettled([request]);

      timeoutSpy.mockRestore();
      h.hang = false;
    }

    console.log(`TIMEOUT_OBSERVATION=${outcome}`);
    console.log(`ABORT_SIGNAL_CALLS=${h.abortCalls}`);

    expect(outcome).toBe("rejected");
    expect(h.abortCalls).toBeGreaterThan(0);

    const retry = await registeredPoolForMint(MINT);

    expect(retry).toBeNull();
    expect(h.reads).toBe(2);

    console.log("TIMEOUT_RELEASE=PASS");
    console.log("RETRY_AFTER_TIMEOUT=PASS");
  });
});
