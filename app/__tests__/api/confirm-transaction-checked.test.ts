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

/**
 * Decide whether ONE call's result is checked, bound to that call rather than
 * to its neighbourhood.
 *
 * An earlier version of this scan looked for `assertSuccessfulConfirmation`
 * anywhere within ±500 characters, which CodeRabbit correctly flagged on #2519:
 * a bare confirmation sitting next to a guarded one would pass. That defeats the
 * point of a guard whose whole job is catching the NEXT call site.
 *
 * Every call in the tree is one of two shapes, so both are recognised exactly:
 *
 *   A  assertSuccessfulConfirmation(await conn.confirmTransaction(...), "...")
 *   B  const result = await conn.confirmTransaction(...)   // then result is
 *                                                          // asserted or
 *                                                          // result.value.err
 *                                                          // is inspected
 *
 * Shape B is tied to the BINDING NAME, so an unrelated guarded call elsewhere
 * in the file cannot vouch for it.
 */
function isChecked(code: string, callIdx: number): boolean {
  const before = code.slice(0, callIdx);

  // A: the call is the argument to the assertion. Allow the receiver
  // expression and an `await` between the paren and the call.
  if (/assertSuccessfulConfirmation\(\s*(?:await\s+)?[\w$.]*$/.test(before)) {
    return true;
  }

  // B: the call's result is bound; require that binding to be checked later.
  const bound = before.match(/(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:await\s+)?[\w$.]*$/);
  if (bound) {
    const name = bound[1];
    const after = code.slice(callIdx);
    const asserted = new RegExp(
      `assertSuccessfulConfirmation\\(\\s*${name}\\b`,
    ).test(after);
    const inspected = new RegExp(`\\b${name}\\.value\\.err\\b`).test(after);
    return asserted || inspected;
  }

  return false;
}

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const file of routeFiles(API_DIR)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of code.matchAll(/\.confirmTransaction\(/g)) {
      const idx = m.index ?? 0;
      sites.push({
        file: path.relative(API_DIR, file),
        line: code.slice(0, idx).split("\n").length,
        checked: isChecked(code, idx),
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
