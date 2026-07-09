/**
 * GH#2335 / PR#2336 follow-up: unit tests for lib/prefund-claim-store.ts, the
 * durable (Vercel Blob-backed) replacement for the old per-lambda in-memory
 * `_preFundClaims` Map that /api/devnet-pre-fund falls back to when Supabase is
 * unavailable.
 *
 * @vercel/blob is mocked with an in-memory fake that reproduces the ONE behavior
 * this store's atomicity depends on: `put(pathname, body)` (allowOverwrite left at
 * its default of false) throws if a blob already exists at that pathname. That's a
 * real, documented Vercel Blob behavior — this codebase already relies on the
 * inverse of it elsewhere (see the `allowOverwrite: true` comments in
 * playground-nonce-store.ts / playground-registered-markets.ts: "Without this, only
 * the first-ever write succeeds").
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
        // Mirrors the real Vercel Blob error when writing to an existing pathname
        // without allowOverwrite: true.
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

// Imported after the mock so the module under test picks up the mocked @vercel/blob.
const { reserveClaim, releaseClaim, peekClaim } = await import(
  "@/lib/prefund-claim-store"
);

const KEY_A = "WALLET_A:devnet-pre-fund:MINT_X";
const KEY_B = "WALLET_B:devnet-pre-fund:MINT_X";

describe("prefund-claim-store: reserveClaim / releaseClaim semantics", () => {
  it("first reservation for a fresh key succeeds", async () => {
    const result = await reserveClaim(KEY_A, 60_000);
    expect(result.reserved).toBe(true);
    expect(result.nextClaimAt).toBeNull();
  });

  it("a second reservation for the same still-active key is denied", async () => {
    const first = await reserveClaim(KEY_A, 60_000);
    expect(first.reserved).toBe(true);

    const second = await reserveClaim(KEY_A, 60_000);
    expect(second.reserved).toBe(false);
    expect(second.nextClaimAt).not.toBeNull();
  });

  it("reservations for different keys don't interfere", async () => {
    const a = await reserveClaim(KEY_A, 60_000);
    const b = await reserveClaim(KEY_B, 60_000);
    expect(a.reserved).toBe(true);
    expect(b.reserved).toBe(true);
  });

  it("CONCURRENT reserve attempts for the SAME key: exactly one succeeds", async () => {
    // Five requests race to reserve the same rateKey at once — models concurrent
    // requests landing on different Vercel lambda instances, which is exactly the
    // cross-instance gap GH#2335 flagged in the old per-lambda in-memory Map.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveClaim(KEY_A, 60_000)),
    );

    const reserved = results.filter((r) => r.reserved);
    const denied = results.filter((r) => !r.reserved);
    expect(reserved).toHaveLength(1);
    expect(denied).toHaveLength(4);
    // Every denial should carry a real expiry, not a silent pass-through.
    for (const d of denied) {
      expect(d.nextClaimAt).not.toBeNull();
    }
  });

  it("releaseClaim frees the slot so a subsequent reservation succeeds", async () => {
    const first = await reserveClaim(KEY_A, 60_000);
    expect(first.reserved).toBe(true);

    // Simulates route.ts's txErr catch path: mint failed, release the reservation.
    await releaseClaim(KEY_A);

    const second = await reserveClaim(KEY_A, 60_000);
    expect(second.reserved).toBe(true);
  });

  it("releaseClaim on a key with no active claim is a safe no-op", async () => {
    await expect(releaseClaim("NEVER_RESERVED_KEY")).resolves.toBeUndefined();
  });

  it("an expired claim can be reserved again", async () => {
    const first = await reserveClaim(KEY_A, 1); // 1ms TTL — expires almost immediately
    expect(first.reserved).toBe(true);

    await new Promise((r) => setTimeout(r, 20));

    const second = await reserveClaim(KEY_A, 60_000);
    expect(second.reserved).toBe(true);
  });

  it("peekClaim reflects reservation state without itself reserving", async () => {
    const before = await peekClaim(KEY_A);
    expect(before.limited).toBe(false);

    await reserveClaim(KEY_A, 60_000);

    const after = await peekClaim(KEY_A);
    expect(after.limited).toBe(true);
    expect(after.nextClaimAt).not.toBeNull();

    // peekClaim must not itself have reserved anything — a real reserveClaim after
    // it should still see the same (single) active claim, not a second one.
    const stillOnlyOneActive = await reserveClaim(KEY_A, 60_000);
    expect(stillOnlyOneActive.reserved).toBe(false);
  });
});
