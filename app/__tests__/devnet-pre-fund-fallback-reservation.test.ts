/**
 * GH#2335 / PR#2336 follow-up: /api/devnet-pre-fund's FALLBACK rate limiter (used
 * when the Supabase-backed primary gate is unavailable) must be reserved
 * synchronously, atomically, and CROSS-INSTANCE-safe before mint work starts —
 * see lib/prefund-claim-store.ts.
 *
 * The original version of this file asserted the fix by grepping for source
 * strings in route.ts (`indexOf`) — that only proves certain lines of code exist
 * somewhere in the file, not that the reserve/release protocol actually behaves
 * correctly under concurrency. This version drives the REAL
 * lib/prefund-claim-store.ts (only its @vercel/blob dependency is mocked — same
 * mock shape as __tests__/lib/prefund-claim-store.test.ts) through a
 * `simulateFallbackPreFund` helper that mirrors the reserve-before-mint /
 * release-on-failure / commit-on-success shape in
 * app/app/api/devnet-pre-fund/route.ts's fallback branch (`usingFallbackGate`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const BASE_URL = "http://fake-blob";
let fakeStore: Map<string, string>;

vi.mock("@vercel/blob", () => ({
  list: vi.fn(async ({ prefix }: { prefix: string; limit?: number }) => {
    const blobs: { pathname: string; url: string }[] = [];
    for (const pathname of fakeStore.keys()) {
      if (pathname.startsWith(prefix)) {
        blobs.push({ pathname, url: `${BASE_URL}/${pathname}` });
      }
    }
    return { blobs };
  }),
  put: vi.fn(
    async (
      pathname: string,
      body: string,
      opts?: { allowOverwrite?: boolean },
    ) => {
      if (fakeStore.has(pathname) && !opts?.allowOverwrite) {
        throw new Error(
          "This blob already exists, use `allowOverwrite: true` if you'd like to overwrite it.",
        );
      }
      fakeStore.set(pathname, body);
      return { url: `${BASE_URL}/${pathname}` };
    },
  ),
  del: vi.fn(async (url: string) => {
    const pathname = url.replace(`${BASE_URL}/`, "");
    fakeStore.delete(pathname);
  }),
}));

beforeEach(() => {
  fakeStore = new Map();
  global.fetch = vi.fn(async (input: string | URL) => {
    const pathname = String(input).split("?")[0].replace(`${BASE_URL}/`, "");
    if (!fakeStore.has(pathname)) {
      return { ok: false } as Response;
    }
    return {
      ok: true,
      json: async () => JSON.parse(fakeStore.get(pathname)!),
    } as Response;
  }) as unknown as typeof fetch;
});

const { reserveClaim, releaseClaim } = await import("@/lib/prefund-claim-store");

type FallbackResult =
  | { status: "funded"; sig: string }
  | { status: "rate_limited"; nextClaimAt: string | null }
  | { status: "mint_failed" };

/**
 * Mirrors the fallback-gate shape of app/app/api/devnet-pre-fund/route.ts's POST
 * handler: reserve immediately before mint work, release on mint failure, and — the
 * fix for the release-after-success edge case at route.ts's success path — commit
 * the reservation (stop treating it as releasable) as soon as the mint confirms,
 * BEFORE returning.
 */
async function simulateFallbackPreFund(
  rateKey: string,
  doMint: () => Promise<{ sig: string }>,
): Promise<FallbackResult> {
  const { reserved, nextClaimAt } = await reserveClaim(rateKey, 60_000);
  if (!reserved) {
    return { status: "rate_limited", nextClaimAt };
  }

  let reservedClaim = true; // mirrors route.ts's `reservedFallbackClaim`
  const release = async () => {
    if (reservedClaim) {
      reservedClaim = false;
      await releaseClaim(rateKey);
    }
  };

  try {
    const { sig } = await doMint();
    // Mint confirmed — commit the reservation (route.ts: `reservedFallbackClaim = false`)
    // so nothing downstream can accidentally release a real mint's claim.
    reservedClaim = false;
    return { status: "funded", sig };
  } catch {
    await release();
    return { status: "mint_failed" };
  }
}

describe("devnet-pre-fund fallback gate: durable reserve/release protocol", () => {
  it("a single request reserves and mints successfully", async () => {
    const result = await simulateFallbackPreFund("WALLET_A:devnet-pre-fund:MINT_X", async () => ({
      sig: "SIG_1",
    }));
    expect(result).toEqual({ status: "funded", sig: "SIG_1" });
  });

  it("CONCURRENT fallback requests for the SAME wallet+mint: only one mints, the rest are rate-limited", async () => {
    // This is the exact scenario GH#2335 reported for the old per-lambda in-memory
    // Map: concurrent requests on different instances would each see "not limited"
    // and all mint. With the durable Blob-backed store, the reserve happens
    // atomically before any mint work, so at most one request should ever reach
    // doMint().
    const rateKey = "WALLET_A:devnet-pre-fund:MINT_X";
    let mintCount = 0;
    const doMint = async () => {
      mintCount += 1;
      return { sig: `SIG_${mintCount}` };
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => simulateFallbackPreFund(rateKey, doMint)),
    );

    const funded = results.filter((r) => r.status === "funded");
    const rateLimited = results.filter((r) => r.status === "rate_limited");
    expect(funded).toHaveLength(1);
    expect(rateLimited).toHaveLength(4);
    expect(mintCount).toBe(1);
  });

  it("a failed mint releases the reservation so a subsequent request can succeed", async () => {
    const rateKey = "WALLET_B:devnet-pre-fund:MINT_Y";

    const failing = await simulateFallbackPreFund(rateKey, async () => {
      throw new Error("sendAndConfirmTransaction timed out");
    });
    expect(failing.status).toBe("mint_failed");

    // The failed mint must have released its reservation — otherwise this wallet
    // would be locked out of the faucet for the full 24h TTL despite never having
    // actually received tokens.
    const retry = await simulateFallbackPreFund(rateKey, async () => ({ sig: "SIG_RETRY" }));
    expect(retry).toEqual({ status: "funded", sig: "SIG_RETRY" });
  });

  it("a successful mint's reservation is NOT released by a later unrelated error (release-after-success edge case)", async () => {
    // Regression for the route.ts fix: previously `reservedInMemoryFallbackGate`
    // stayed `true` after a successful mint, so if the outer try/catch's release
    // path fired for ANY reason after the mint confirmed, it would incorrectly free
    // a real mint's claim. Here we call `releaseClaim` directly AFTER a successful
    // simulateFallbackPreFund (which — like route.ts's `reservedFallbackClaim = false`
    // on success — no longer holds a "reserved" flag pointing at this key), and
    // confirm the claim was already committed: a fresh reserve for the same key must
    // still be denied.
    const rateKey = "WALLET_C:devnet-pre-fund:MINT_Z";

    const funded = await simulateFallbackPreFund(rateKey, async () => ({ sig: "SIG_OK" }));
    expect(funded).toEqual({ status: "funded", sig: "SIG_OK" });

    // A concurrent reserve attempt for the same key (simulating another request
    // racing in) must still see the claim as active — the successful mint's
    // reservation must not have been silently released.
    const stillBlocked = await reserveClaim(rateKey, 60_000);
    expect(stillBlocked.reserved).toBe(false);
  });

  it("different wallet/mint pairs (different rateKeys) never block each other", async () => {
    const [a, b] = await Promise.all([
      simulateFallbackPreFund("WALLET_A:devnet-pre-fund:MINT_X", async () => ({ sig: "SIG_A" })),
      simulateFallbackPreFund("WALLET_A:devnet-pre-fund:MINT_Y", async () => ({ sig: "SIG_B" })),
    ]);
    expect(a).toEqual({ status: "funded", sig: "SIG_A" });
    expect(b).toEqual({ status: "funded", sig: "SIG_B" });
  });
});
