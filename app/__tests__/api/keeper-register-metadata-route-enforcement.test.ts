/**
 * Regression: the metadata validator must be ENFORCED BY THE ROUTE, not merely
 * exist as a library.
 *
 * keeper-register-metadata-validation.test.ts covers lib/market-metadata-validation
 * in isolation. That unit alone cannot fail if the guard is deleted from
 * app/api/playground/keeper-register/route.ts — i.e. it does not bind the actual
 * fix for GH#2466, which is the WIRING of that validator into the live path.
 *
 * This test drives the real route handler: an impersonation payload must be
 * rejected with 400 and the validator's own error text, before any registry
 * write. Deleting the guard from the route makes this fail (the request instead
 * falls through to the H1 auth check), which is exactly the binding the unit
 * test is missing.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route reads NETWORK at module scope — must be devnet before the import.
const prevNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
afterAll(() => {
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = prevNetwork;
});

// Any registry write is a failure for this test: the guard runs before them.
const blobPut = vi.fn(async () => ({ url: "https://blob.invalid/x" }));
const supabaseUpsert = vi.fn(async () => ({ error: null }));

vi.mock("@vercel/blob", () => ({
  put: blobPut,
  list: vi.fn(async () => ({ blobs: [] })),
  head: vi.fn(async () => null),
  del: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => ({
    from: () => ({
      upsert: supabaseUpsert,
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const { POST } = await import("@/app/api/playground/keeper-register/route");

// Real base58 pubkeys so the route's address validation passes and execution
// reaches the metadata guard.
const SLAB = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
const POOL = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/playground/keeper-register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slabAddress: SLAB, dexPoolAddress: POOL, ...body }),
    }),
  );

describe("keeper-register enforces market-metadata validation on the live path", () => {
  beforeEach(() => {
    blobPut.mockClear();
    supabaseUpsert.mockClear();
  });

  const cp = (n: number) => String.fromCodePoint(n);

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["body symbol — Cyrillic homoglyph", { symbol: "ЅОL" }, /Invalid symbol/],
    ["body label — RTL override", { label: "SOL/USD Perpetual" + cp(0x202e) }, /Invalid name/],
    ["payload.symbol — overlong", { payload: { symbol: "A".repeat(21) } }, /Invalid symbol/],
    ["payload.name — zero-width", { payload: { name: "SOL" + cp(0x200b) + "/USD" } }, /Invalid name/],
    ["payload.name — control char", { payload: { name: "SOL/USD\x00" } }, /Invalid name/],
  ];

  it.each(cases)("rejects %s with 400 and writes nothing", async (_label, body, expected) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: string }).error)).toMatch(expected);
    expect(blobPut).not.toHaveBeenCalled();
    expect(supabaseUpsert).not.toHaveBeenCalled();
  });

  it("does not reject legitimate metadata at the metadata guard", async () => {
    const res = await post({ symbol: "SOL", label: "Solana Perpetual" });
    // It must get PAST the metadata guard. It is then stopped by H1 auth
    // (no deployer/signature), which is a different, non-400-metadata outcome.
    if (res.status === 400) {
      const err = String(((await res.json()) as { error?: string }).error);
      expect(err).not.toMatch(/Invalid symbol|Invalid name/);
    }
  });
});
