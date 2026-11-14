// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { provenance } from "../../../scripts/bot-api/provenance";

describe("loadtest provenance (skeptic F2)", () => {
  it("reports the HEAD sha and the flags it was run with, never env", () => {
    process.env.LOADTEST_API_KEY = "pbk_secret_should_not_appear";
    const p = provenance(["node", "/x/scripts/bot-api/loadtest.ts", "--mode", "inproc", "--requests", "10"]);
    expect(p.sha).toBe(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(p.command).toBe("npx tsx loadtest.ts --mode inproc --requests 10");
    expect(JSON.stringify(p)).not.toContain("secret");
    delete process.env.LOADTEST_API_KEY;
  });
  it("loadtest.ts puts it in the report", () => {
    expect(readFileSync(join(process.cwd(), "scripts/bot-api/loadtest.ts"), "utf8")).toContain("...provenance(),");
  });
});
