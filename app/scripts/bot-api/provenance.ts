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

/** True when the working tree has uncommitted changes (git status --porcelain is not empty); null when git cannot say. */
export function gitDirty(cwd: string = process.cwd()): boolean | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return null;
  }
}

export function provenance(argv: string[] = process.argv, cwd: string = process.cwd()): { sha: string | null; dirty: boolean | null; command: string } {
  return { sha: gitSha(cwd), dirty: gitDirty(cwd), command: ["npx", "tsx", basename(argv[1] ?? "loadtest.ts"), ...argv.slice(2)].join(" ") };
}
