// @vitest-environment node
/**
 * GH#1375: auto-fund 403 on production — NEXT_PUBLIC_SOLANA_NETWORK not 'devnet'
 *
 * Tests that the route correctly checks both env vars so a deployment using
 * NEXT_PUBLIC_DEFAULT_NETWORK=devnet (canonical) works even if
 * NEXT_PUBLIC_SOLANA_NETWORK is not set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("/api/auto-fund network guard (GH#1375)", () => {
  const routePath = path.resolve(
    __dirname,
    "../../app/api/auto-fund/route.ts",
  );

  it("checks NEXT_PUBLIC_DEFAULT_NETWORK as primary env var", () => {
    const source = fs.readFileSync(routePath, "utf8");
    expect(source).toContain("NEXT_PUBLIC_DEFAULT_NETWORK");
  });

  it("retains NEXT_PUBLIC_SOLANA_NETWORK as legacy fallback", () => {
    const source = fs.readFileSync(routePath, "utf8");
    expect(source).toContain("NEXT_PUBLIC_SOLANA_NETWORK");
  });

  it("uses nullish coalescing so DEFAULT_NETWORK takes precedence", () => {
    const source = fs.readFileSync(routePath, "utf8");
    // The primary check should use ?. and ?? to chain the two env vars
    expect(source).toMatch(/NEXT_PUBLIC_DEFAULT_NETWORK.*\?\..*trim.*\?\?/s);
  });

  it("trims env var values (handles Vercel copy-paste whitespace)", () => {
    const source = fs.readFileSync(routePath, "utf8");
    // Both env vars should use .trim()
    const trimMatches = (source.match(/\.trim\(\)/g) ?? []).length;
    expect(trimMatches).toBeGreaterThanOrEqual(2);
  });
});
