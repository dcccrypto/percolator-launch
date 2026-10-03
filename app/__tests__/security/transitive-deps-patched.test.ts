// @vitest-environment node
/**
 * #2528 — transitive production dependencies that failed `pnpm audit --prod`.
 *
 * The fix is a pnpm override in the root package.json. An override is only as
 * good as what actually resolves on disk, so this test walks the REAL installed
 * dependency chain (the same paths `pnpm audit` reported) with Node's own
 * resolver and asserts the version each consumer gets is at or above the
 * patched floor. It does not read package.json or the lockfile — if someone
 * drops or loosens an override and re-locks, the resolved version regresses
 * and this fails.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(__dirname, "..", "..");

/**
 * Find the directory `pkg` resolves to when required from `fromDir`, using
 * Node's own node_modules lookup order (`require.resolve.paths`). We look for
 * the package directory rather than resolving `pkg/package.json`, because
 * several packages on these chains do not export `./package.json`.
 */
function pkgDir(pkg: string, fromDir: string): string {
  const req = createRequire(resolve(fromDir, "noop.js"));
  for (const base of req.resolve.paths(pkg) ?? []) {
    const candidate = resolve(base, pkg, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
  }
  throw new Error(`${pkg} is not resolvable from ${fromDir}`);
}

/** Follow a dependency chain from the app, exactly like an audit path. */
function versionVia(chain: string[]): string {
  let dir = APP_DIR;
  for (const pkg of chain) dir = pkgDir(pkg, dir);
  return JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).version;
}

function gte(a: string, b: string): boolean {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

const CASES: { name: string; chain: string[]; floor: string; below?: string; advisories: string }[] = [
  {
    name: "axios via the Trezor/Stellar wallet-adapter chain",
    chain: [
      "@solana/wallet-adapter-wallets",
      "@solana/wallet-adapter-trezor",
      "@trezor/connect-web",
      "@trezor/connect",
      "@trezor/blockchain-link",
      "@stellar/stellar-sdk",
      "axios",
    ],
    floor: "1.20.0",
    below: "2.0.0",
    advisories: "GHSA-c29m-xwm3-cm6r, GHSA-mghh-pgcx-3jjj, GHSA-x97p-jq2g-jp4f, GHSA-3pq3-5fj3-cg6v, GHSA-542g-h47m-68v8, GHSA-m8m8-qj5v-23w3, GHSA-r4gj-5m52-g5wh",
  },
  {
    name: "brace-expansion via @sentry/nextjs > glob > minimatch",
    chain: ["@sentry/nextjs", "@sentry/bundler-plugin-core", "glob", "minimatch", "brace-expansion"],
    floor: "5.0.12",
    advisories: "GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr",
  },
  {
    name: "fast-uri via @sentry/nextjs > webpack > schema-utils > ajv",
    chain: ["@sentry/nextjs", "@sentry/webpack-plugin", "webpack", "schema-utils", "ajv", "fast-uri"],
    floor: "3.1.8",
    below: "4.0.0",
    advisories: "GHSA-hrr3-gc8f-f4qj",
  },
];

describe("#2528 transitive deps resolve to patched versions", () => {
  for (const c of CASES) {
    it(`${c.name} is >= ${c.floor}${c.below ? ` and < ${c.below}` : ""} (${c.advisories})`, () => {
      const v = versionVia(c.chain);
      expect(gte(v, c.floor), `${c.chain.at(-1)} resolved to ${v}, needs >= ${c.floor}`).toBe(true);
      if (c.below) {
        expect(gte(v, c.below), `${c.chain.at(-1)} resolved to ${v}, must stay < ${c.below} (same major)`).toBe(false);
      }
    });
  }
});
