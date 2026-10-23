// @vitest-environment node
/** flag-on-delta.mjs caps vitest workers (FLAG_DELTA_MAX_WORKERS, default 4) on every spawn. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const script = path.join(__dirname, "../../scripts/flag-on-delta.mjs");
const argsOf = (env: Record<string, string | undefined>) =>
  JSON.parse(execFileSync(process.execPath, [script, "--print-vitest-args"], { env: { ...process.env, ...env }, encoding: "utf8" })) as string[];

describe("flag-on-delta worker cap", () => {
  it("default 4, env override, and every spawn goes through vitestArgs", () => {
    expect(argsOf({ FLAG_DELTA_MAX_WORKERS: undefined })).toEqual(["vitest", "run", "--maxWorkers=4", "--reporter=json", "--outputFile=<out>"]);
    expect(argsOf({ FLAG_DELTA_MAX_WORKERS: "2" })).toContain("--maxWorkers=2");
    const src = readFileSync(script, "utf8");
    expect(src.match(/spawnSync\(/g)).toHaveLength(1);
    expect(src).toContain('spawnSync("npx", vitestArgs(out)');
  });
});
