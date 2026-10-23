/**
 * Audit 2026-10-17 S3-C8: POST /api/devnet-register-mint let any caller, unauthenticated, write
 * a `devnet_mints` row for any existing SPL mint with a caller-chosen name, symbol and decimals
 * (decimals not read from chain, ownership not checked — the route's own comment said so).
 * Nothing in the app, scripts or sibling repos called it, so it was removed, like
 * /api/devnet-mirror-mint (#3473). The devnet_mints table and its readers are unchanged.
 *
 * The whole app/api tree is walked: a `devnet-register-mint` directory beneath route groups
 * would still answer at /api/devnet-register-mint.
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

describe("S3-C8: /api/devnet-register-mint stays removed", () => {
  it("the walk sees the API tree (guards the scan itself)", () => {
    expect(dirsNamed("devnet-airdrop")).toEqual(["devnet-airdrop"]);
  });

  it("has no devnet-register-mint directory anywhere under app/api", () => {
    expect(dirsNamed("devnet-register-mint")).toEqual([]);
  });
});
