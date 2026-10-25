/**
 * Every production render of DepositWithdrawPanel passes `exitV22`: under the v2.2 flag a render without it falls back
 * to the legacy one-step exit (a bare tag 77 with no quote, and no cancel / re-request for a stuck claim).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..", "..", "..");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    if (["node_modules", "__tests__", ".next"].includes(n)) return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) ? [p] : [];
  });

describe("every <DepositWithdrawPanel> render passes exitV22", () => {
  it("app/ and components/", () => {
    const renders = new Map<string, string>();
    for (const f of [...walk(join(APP, "app")), ...walk(join(APP, "components"))]) {
      for (const m of readFileSync(f, "utf8").matchAll(/<DepositWithdrawPanel\b[\s\S]*?\/>/g)) renders.set(`${f}@${m.index}`, m[0]);
    }
    // Exactly the hub rail and /earn/[slab]: a new caller (or a render this scan misreads) has to be looked at here.
    expect(renders.size).toBe(2);
    expect([...renders].filter(([, jsx]) => !/\bexitV22=/.test(jsx)).map(([k]) => k)).toEqual([]);
  });
});
