/** What a load-test report was run from: the commit and the command line (flags only, never env, so no key can leak in). */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export function gitSha(cwd: string = process.cwd()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function provenance(argv: string[] = process.argv, cwd: string = process.cwd()): { sha: string | null; command: string } {
  return { sha: gitSha(cwd), command: ["npx", "tsx", basename(argv[1] ?? "loadtest.ts"), ...argv.slice(2)].join(" ") };
}
