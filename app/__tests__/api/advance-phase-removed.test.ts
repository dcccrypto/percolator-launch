/**
 * #3476: /api/oracle/advance-phase sent AdvanceOraclePhase (v12 tag 92), signed by CRANK_KEYPAIR.
 * The instruction does not exist in v17, so the SDK's encodeAdvanceOraclePhase() always throws and
 * the route could never send — yet every trade-page mount of a v17/v18 market POSTed to it
 * (SlabProvider hard-codes oraclePhase 0), and the route loaded the crank key and an RPC connection
 * before failing. The route, its hook, the hook's page mount and the route-only rate limiter were
 * removed.
 *
 * The defect is calling the always-throwing encoder behind a server key, not the URL, so the guard
 * bans the encoder and its account list anywhere in app source — a renamed route or hook would
 * still need them — as well as the old names. Same walker as retired-api-callers.test.ts.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const APP = resolve(__dirname, "..", "..");
const API_DIR = join(APP, "app", "api");

const SKIP = new Set(["node_modules", ".next", "__tests__", "e2e", "coverage", "test-results", "playwright-report"]);
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name)) files.push(p);
  }
};
walk(APP);

function dirsNamed(name: string, dir = API_DIR): string[] {
  const hits: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    if (e.name === name) hits.push(relative(API_DIR, full));
    hits.push(...dirsNamed(name, full));
  }
  return hits;
}

describe("#3476: the dead AdvanceOraclePhase crank path stays removed", () => {
  it("scans the app tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it.each([
    ["encodeAdvanceOraclePhase", /\bencodeAdvanceOraclePhase\b/],
    ["ACCOUNTS_ADVANCE_ORACLE_PHASE", /\bACCOUNTS_ADVANCE_ORACLE_PHASE\b/],
    ["useAdvanceOraclePhase", /\buseAdvanceOraclePhase\b/],
    ["advance-phase", /advance-phase/],
  ])("no app source mentions %s", (_label, re) => {
    const hits = files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(APP, f));
    expect(hits).toEqual([]);
  });

  it("the walk sees the API tree (guards the directory scan)", () => {
    expect(dirsNamed("resolve")).toEqual([join("oracle", "resolve")]);
  });

  it("has no advance-phase directory anywhere under app/api (route groups included)", () => {
    expect(dirsNamed("advance-phase")).toEqual([]);
  });

  it.each(["hooks/useAdvanceOraclePhase.ts", "lib/advance-phase-rate-limit.ts"])("%s is gone", (f) => {
    expect(existsSync(join(APP, f))).toBe(false);
  });
});
