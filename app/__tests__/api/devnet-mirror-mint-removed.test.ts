/**
 * #3473: POST /api/devnet-mirror-mint created a new SPL mint per accepted request, paid by the
 * shared devnet mint authority, for any caller and any listed mainnet token — with no dedup at
 * all when Supabase was unavailable. Nothing had called it since the wizard moved to Sim-USDC
 * collateral (b358fb90), so it was removed. The devnet_mints table and its readers
 * (devnet-pre-fund, devnet-airdrop, markets) are unchanged.
 *
 * Next.js serves the URL from a `devnet-mirror-mint` directory anywhere under app/api that
 * sits only beneath route groups — `(devnet)/devnet-mirror-mint/route.ts` answers at
 * /api/devnet-mirror-mint too — so the whole tree is walked, not one path.
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

describe("#3473: /api/devnet-mirror-mint stays removed", () => {
  it("the walk sees the API tree (guards the scan itself)", () => {
    expect(dirsNamed("devnet-airdrop")).toEqual(["devnet-airdrop"]);
  });

  it("has no devnet-mirror-mint directory anywhere under app/api", () => {
    expect(dirsNamed("devnet-mirror-mint")).toEqual([]);
  });
});
