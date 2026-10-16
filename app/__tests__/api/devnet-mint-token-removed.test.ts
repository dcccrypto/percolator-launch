/**
 * #3469: POST /api/devnet-mint-token converted $500 into a token amount with DexScreener's
 * priceUsd and minted it from the shared devnet mint authority with no ceiling — a
 * dust-priced token turned one request into tens of billions of tokens. Nothing in the app
 * had called it since the wizard moved to Sim-USDC collateral (b358fb90), so it was removed
 * rather than hardened. /api/devnet-airdrop is the live $500 path and clamps to MAX_RAW.
 *
 * Next.js serves the URL from a `devnet-mint-token` directory anywhere under app/api that
 * sits only beneath route groups — `(devnet)/devnet-mint-token/route.ts` answers at
 * /api/devnet-mint-token too — so the whole tree is walked, not one path.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const API_DIR = path.resolve(__dirname, "../../app/api");

function dirsNamed(name: string, dir = API_DIR): string[] {
  const hits: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === name) hits.push(path.relative(API_DIR, full));
    hits.push(...dirsNamed(name, full));
  }
  return hits;
}

describe("#3469: /api/devnet-mint-token stays removed", () => {
  it("the walk sees the API tree (guards the scan itself)", () => {
    expect(dirsNamed("devnet-airdrop")).toEqual(["devnet-airdrop"]);
  });

  it("has no devnet-mint-token directory anywhere under app/api", () => {
    expect(dirsNamed("devnet-mint-token")).toEqual([]);
  });

  it("its only helper, the orphaned rate limiter, is gone too", () => {
    expect(fs.existsSync(path.resolve(__dirname, "../../lib/devnet-mirror-mint-rate-limit.ts"))).toBe(false);
  });
});
