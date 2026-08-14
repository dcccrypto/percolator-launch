/**
 * GH#2517 — every `confirmTransaction()` in an API route must have its result
 * checked.
 *
 * `Connection.confirmTransaction()` can RESOLVE with a `SignatureResult` whose
 * `err` records an on-chain execution failure — awaiting it proves the RPC call
 * completed, not that the transaction succeeded. Seven routes discarded that
 * result and advanced success-only state anyway: persisting a mint address for
 * a mint that was never created, consuming a 24-hour faucet claim, and telling
 * callers that tokens were delivered.
 *
 * The repo already had the right answer — `assertSuccessfulConfirmation()`,
 * which accepts only an explicit `value.err === null` and so also fails closed
 * on a malformed or incomplete result. Two routes already used it. This is the
 * guard that stops the next call site being written without it.
 *
 * Deliberately a source scan rather than per-route tests: the property is "no
 * call site anywhere is bare", which is a statement about the whole surface. A
 * test per known route would say nothing about the eighth one somebody adds.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const API_DIR = path.resolve(__dirname, "../../app/api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** Strip line comments so prose mentioning confirmTransaction() isn't counted. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

interface Site {
  file: string;
  line: number;
  checked: boolean;
}

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const file of routeFiles(API_DIR)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of code.matchAll(/\.confirmTransaction\(/g)) {
      const idx = m.index ?? 0;
      const window = code.slice(Math.max(0, idx - 500), idx + 500);
      sites.push({
        file: path.relative(API_DIR, file),
        line: code.slice(0, idx).split("\n").length,
        // Either the shared helper, or auto-fund's older hand-rolled
        // `airdropResult.value.err` check — both enforce the invariant.
        checked:
          window.includes("assertSuccessfulConfirmation") ||
          /\.value\.err/.test(window),
      });
    }
  }
  return sites;
}

describe("GH#2517: no API route discards a confirmTransaction result", () => {
  it("finds the call sites at all (guards the scan itself)", () => {
    // If a refactor moves these calls behind a wrapper, this test starts
    // passing vacuously — so assert the scan still sees something.
    expect(callSites().length).toBeGreaterThanOrEqual(10);
  });

  it("checks every one of them", () => {
    const bare = callSites().filter((s) => !s.checked);
    expect(
      bare.map((s) => `${s.file}:${s.line}`),
      "confirmTransaction() result discarded — wrap it in assertSuccessfulConfirmation()",
    ).toEqual([]);
  });

  it("the seven routes GH#2517 named import the shared helper", () => {
    const named = [
      "devnet-airdrop/route.ts",
      "devnet-mint-token/route.ts",
      "devnet-mirror-mint/route.ts",
      "playground/faucet/route.ts",
    ];
    for (const rel of named) {
      const src = fs.readFileSync(path.join(API_DIR, rel), "utf8");
      expect(src, rel).toContain(
        'from "@/lib/transaction-confirmation"',
      );
    }
  });
});
