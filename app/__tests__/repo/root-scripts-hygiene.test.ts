/**
 * #2750 (reported by v1ktorrr0x): the repo root pinned @percolatorct/sdk ^4.4.0 (v17 era)
 * while the app uses 8.0.0, and the root operator scripts encoded the stale v17 ABI.
 * The dead scripts are deleted; this keeps them (and the version skew) from coming back.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "..");
const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(ROOT, p), "utf8")) as Record<string, unknown>;

const rootPkg = readJson("package.json") as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
};
const appPkg = readJson("app/package.json") as { dependencies: Record<string, string> };

const REMOVED_FILES = [
  "scripts/create-market.ts",
  "scripts/close-market-reclaim-all.ts",
  "scripts/rescue-and-recreate.ts",
  "scripts/admin-resolve-and-close.ts",
  "scripts/floating-maker.ts",
  "scripts/finish-market-tx5-tx6.mjs",
  "scripts/mm-fleet.ts",
  "scripts/deploy-mm-fleet.sh",
];
const REMOVED_SCRIPT_NAMES = ["maker", "maker:dry", "fleet", "fleet:dry", "fleet:deploy", "fleet:deploy:dry"];

describe("root scripts hygiene (#2750)", () => {
  it("removed dead v17 root scripts are gone from disk", () => {
    const present = REMOVED_FILES.filter((f) => existsSync(resolve(ROOT, f)));
    expect(present).toEqual([]);
  });

  it("removed script names are absent from root package.json scripts", () => {
    const present = REMOVED_SCRIPT_NAMES.filter((n) => n in rootPkg.scripts);
    expect(present).toEqual([]);
  });

  it("every root package.json script that runs a scripts/ or tests/ file points at a file that exists", () => {
    const missing: string[] = [];
    for (const [name, cmd] of Object.entries(rootPkg.scripts)) {
      for (const m of cmd.matchAll(/\b((?:scripts|tests)\/[\w./-]+\.(?:ts|mjs|js|sh))\b/g)) {
        if (!existsSync(resolve(ROOT, m[1]!))) missing.push(`${name} -> ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("root @percolatorct/sdk pin (if any) matches the app's pin exactly", () => {
    const rootPin = rootPkg.dependencies?.["@percolatorct/sdk"];
    const appPin = appPkg.dependencies["@percolatorct/sdk"];
    expect(appPin).toBeTruthy();
    if (rootPin !== undefined) expect(rootPin).toBe(appPin);
  });

  it("no root scripts/ file imports @percolatorct/sdk under a mismatched root pin", () => {
    const rootPin = rootPkg.dependencies?.["@percolatorct/sdk"];
    const appPin = appPkg.dependencies["@percolatorct/sdk"];
    const importers = readdirSync(resolve(ROOT, "scripts"))
      .filter((f) => /\.(ts|mjs|js)$/.test(f))
      .filter((f) => readFileSync(resolve(ROOT, "scripts", f), "utf8").includes("@percolatorct/sdk"));
    if (importers.length > 0) expect(rootPin).toBe(appPin);
    else expect(importers).toEqual([]);
  });
});
