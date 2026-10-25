import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readU64LE } from "@/lib/u64le";

// The client bundle's Buffer polyfill has no BigInt read/write methods. A call to
// readBigUInt64LE on any client path threw before the first trade's tx was built
// ("x.Buffer.from(...).readBigUInt64LE is not a function"), so nothing could trade.
describe("browser Buffer BigInt guard", () => {
  it("no client code calls Buffer BigInt read/write methods (server api routes excepted)", () => {
    // No shell: on Windows execSync runs through cmd.exe, which does not treat ' as a quote, so the
    // ':!app/api/**' pathspecs reached git verbatim and it died with
    //   fatal: Invalid path '':/!app': No such file or directory
    // and `|| true` turned that into exit 0 with EMPTY stdout -- so this guard passed whatever the
    // tree contained (proven: a deliberate `b.readBigUInt64LE(0)` added under lib/ still passed).
    // An argv array needs no quoting. The pattern uses [.] / [(] instead of \. / \( because
    // git.exe on Windows drops the backslashes from an argv entry and then rejects the pattern
    // with "Unmatched ( or \(". git grep exits 1 when there is no match: that is the passing case.
    const scope = ["--", "hooks", "lib", "components", "app", ":!app/api/**", ":!**/__tests__/**"];
    // A pathspec typo or a wrong cwd makes `git grep` exit 1 with no output, which is
    // indistinguishable from "no matches" (verified: `git grep -nE x -- no-such-dir` -> exit 1,
    // empty stderr). So the scope is asserted first: 962 files at 3b87aa7b, and the guard is
    // meaningless if it ever searches almost nothing.
    const inScope = execFileSync("git", ["ls-files", ...scope], { cwd: process.cwd(), encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
    expect(inScope.length).toBeGreaterThan(500);

    let out = "";
    try {
      out = execFileSync("git", ["grep", "-nE", "[.](read|write)Big(U)?Int64(LE|BE)[(]", ...scope], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      if (err.status !== 1) throw new Error(`git grep failed (status ${err.status}): ${String(err.stderr ?? "").trim()}`);
    }
    expect(out).toBe("");
  });
  it("readU64LE reads little-endian u64 from a plain Uint8Array (no Buffer methods)", () => {
    const b = new Uint8Array(80);
    new DataView(b.buffer).setBigUint64(64, 123_456_789_012_345n, true);
    expect(readU64LE(b, 64)).toBe(123_456_789_012_345n);
    const sub = b.subarray(8); // non-zero byteOffset
    expect(readU64LE(sub, 56)).toBe(123_456_789_012_345n);
  });
});
