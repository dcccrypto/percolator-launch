/**
 * Regression: the shared per-IP fund limiter must be ENFORCED BY EACH ROUTE.
 *
 * fund-endpoints-ip-rate-limit.test.ts exercises createUpstashRateLimiter in
 * isolation (a different prefix) and imports none of the routes, so deleting the
 * checkFundRateLimit guard from the four fund endpoints leaves it green — it does
 * not bind the fix for GH#2471, which is the WIRING of the limiter into each route.
 *
 * This drives each real POST handler with the limiter mocked to DENY, and asserts
 * a 429 with Retry-After before any spend. Deleting the guard from a route makes
 * that route reach the (mocked-to-throw) Connection instead — i.e. it fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const checkFundRateLimit = vi.fn(async () => ({ allowed: false, retryAfter: 42 }));
vi.mock("@/lib/fund-ip-rate-limit", () => ({ checkFundRateLimit }));

// The guard must run before any of this is touched; if a route reaches these,
// the guard is in the wrong place (or absent).
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: class {
      requestAirdrop() { throw new Error("spend reached despite rate limit"); }
      getAccountInfo() { throw new Error("spend reached despite rate limit"); }
      getBalance() { throw new Error("spend reached despite rate limit"); }
      getLatestBlockhash() { throw new Error("spend reached despite rate limit"); }
    },
  };
});

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";

const ROUTES: Array<[string, string]> = [
  ["/api/faucet", "@/app/api/faucet/route"],
  ["/api/playground/faucet", "@/app/api/playground/faucet/route"],
  ["/api/auto-fund", "@/app/api/auto-fund/route"],
  ["/api/devnet-airdrop", "@/app/api/devnet-airdrop/route"],
];

describe("fund endpoints enforce the shared per-IP limit", () => {
  beforeEach(() => { checkFundRateLimit.mockClear(); });

  it.each(ROUTES)("%s returns 429 when the shared limiter denies", async (_path, mod) => {
    const { POST } = (await import(mod)) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({
          wallet: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
          walletAddress: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
          mintAddress: "So11111111111111111111111111111111111111112",
          type: "sol",
        }),
      }),
    );

    expect(checkFundRateLimit).toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });
});
