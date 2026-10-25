// @vitest-environment node
/**
 * The source-scanning guards must mean the same thing on every contributor's machine.
 *
 * PLAYGROUND.md / CLAUDE.md rule 4 make `pnpm test` the gate a contributor verifies against:
 * 0 failures, then click through the flow. On a Windows checkout that gate did not hold. Git
 * for Windows ships `core.autocrlf=true` in its SYSTEM config (`C:/Program Files/Git/etc/
 * gitconfig`) and the repo carried no `.gitattributes`, so the working tree was CRLF — and
 * `pnpm test` reported 12 deterministic failures in 8 files with nothing wrong in the app:
 *
 *   api/confirm-transaction-checked            2   per-line `//…$` strip leaves CRLF comments
 *   lib/limits/no-nocpi-on-p3                  1   same strip
 *   lib/touch-input-font-size                  4   `css.indexOf("… {\n  input:not(")` -> -1
 *   lib/indexer-db-network-scope               1   `/AND network = \$2\n/`
 *   components/create-market-cancel-on-unmount 1   `indexOf("useEffect(() => {\n    return")`
 *   lib/launch-recovery                        1   `/gateChainResume\(\);\n\s+if/g`
 *   lib/banned-terms-jsx-guard                 1   `/`-spelled SKIP vs path.sep
 *   components/recover-sol-banner-…-followups  1   `toEqual(["lib/wizard-storage.ts"])`
 *
 * Two of those are worse than a red tick. The comment strip silently stopped working, so
 * `confirm-transaction-checked` reported `hooks/useCreateMarket.ts:2726` — a line of PROSE
 * about `connection.confirmTransaction(sig)` — as an unchecked call site. And
 * `banned-terms-jsx-guard`'s SKIP list stopped applying, so the operator-only admin pages
 * and the API routes (explicitly out of scope per §5.1) were swept and produced 8 hits. A
 * guard that reports the wrong thing teaches contributors to ignore it; a skip-list that
 * silently stops applying is the same mechanism that would let a guard pass vacuously.
 *
 * Fixed in two layers, and this file holds both honest:
 *   1. `.gitattributes` (`* text=auto eol=lf`) — every checkout agrees with CI.
 *   2. `__tests__/helpers/source-scan.ts` — `readSource()` normalises newlines at the read
 *      and `toPosixPath()` normalises separators before any comparison, so a guard does not
 *      depend on how the working tree happens to be configured.
 *
 * Both helpers are no-ops on Linux/macOS, which is why the NEGATIVE CONTROLS below build
 * CRLF text and `path.sep`-joined paths in memory rather than relying on the checkout: they
 * reproduce the Windows failure on any machine, and they fail if either helper is reverted.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { normalizeNewlines, readSource, toPosixPath } from "../helpers/source-scan";

/** The real source line that `confirm-transaction-checked` mis-reported, and the strip it uses. */
const PROSE = "            // one launch tx still on `connection.confirmTransaction(sig)`, which waits on";
const CODE = "            const sig = await connection.confirmTransaction(x);";
const stripLineComments = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

const withTempFile = <T>(body: (file: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "source-scan-"));
  try {
    return body(join(dir, "fixture.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("readSource(): a guard's pattern describes the file, not the checkout's line endings", () => {
  const LF = `${PROSE}\n${CODE}\n`;
  const CRLF = LF.replace(/\n/g, "\r\n");

  it("POSITIVE CONTROL: on an LF file it is the plain read, and the strip works", () => {
    withTempFile((file) => {
      writeFileSync(file, LF);
      expect(readSource(file)).toBe(readFileSync(file, "utf8"));
      const stripped = stripLineComments(readSource(file));
      expect(stripped).not.toContain("//");
      expect(stripped).toContain("await connection.confirmTransaction(x)");
    });
  });

  it("NEGATIVE CONTROL: the plain read of the SAME file as CRLF makes the strip a no-op", () => {
    // `.` never matches `\r` and `$` without the `m` flag does not assert before one, so the
    // whole `//…$` match fails and the comment survives. This is the defect, reproduced on
    // any OS: the prose mention then counts as a call site.
    withTempFile((file) => {
      writeFileSync(file, CRLF);
      const raw = readFileSync(file, "utf8");
      expect(stripLineComments(raw)).toContain("// one launch tx still on");
      expect(/\.confirmTransaction\(/.test(stripLineComments(raw).split("\n")[0]!)).toBe(true);
    });
  });

  it("readSource() of that CRLF file strips the comment and keeps only the real call", () => {
    withTempFile((file) => {
      writeFileSync(file, CRLF);
      const stripped = stripLineComments(readSource(file));
      expect(stripped).not.toContain("//");
      expect([...stripped.matchAll(/\.confirmTransaction\(/g)]).toHaveLength(1);
    });
  });

  it("an `\\n`-anchored literal — the other four files' shape — matches either way", () => {
    // touch-input-font-size does css.indexOf("@media (pointer: coarse) {\n  input:not(");
    // launch-recovery does src.match(/const gate = gateChainResume\(\);\n\s+if \(!gate\.ok\)/g).
    const css = "@media (pointer: coarse) {\r\n  input:not([type=checkbox]) { font-size: 16px }\r\n}\r\n";
    expect(css.indexOf("@media (pointer: coarse) {\n  input:not(")).toBe(-1);
    expect(normalizeNewlines(css).indexOf("@media (pointer: coarse) {\n  input:not(")).toBe(0);
    expect(normalizeNewlines(css)).toMatch(/coarse\) \{\n\s+input/);
  });

  it("line COUNT is preserved, so a reported line number still points at the right line", () => {
    const body = "a\nb\nc\n";
    expect(normalizeNewlines(body.replace(/\n/g, "\r\n")).split("\n")).toEqual(body.split("\n"));
    // A lone CR (classic Mac, and what a bad editor leaves behind) collapses too, not doubles.
    expect(normalizeNewlines("a\rb\rc\r").split("\n")).toEqual(["a", "b", "c", ""]);
  });
});

describe("toPosixPath(): one spelling on both sides of a path comparison", () => {
  const ADMIN = ["components", "admin", "OracleFreshnessSection.tsx"].join(sep);
  const SKIP = [/\/admin\//, /\/dev\//, /dev-preview/, /\/api\//, /__tests__/];

  it("POSITIVE CONTROL: a path built with path.sep reads as posix, idempotently", () => {
    expect(toPosixPath(ADMIN)).toBe("components/admin/OracleFreshnessSection.tsx");
    expect(toPosixPath(toPosixPath(ADMIN))).toBe("components/admin/OracleFreshnessSection.tsx");
    expect(toPosixPath("lib/wizard-storage.ts")).toBe("lib/wizard-storage.ts");
  });

  it("NEGATIVE CONTROL: the raw path misses a `/`-spelled skip wherever sep is not `/`", () => {
    // On Linux/macOS this is vacuously the same path and both sides hold; on Windows the raw
    // form escapes every entry of SKIP, which is how the admin pages got swept.
    expect(SKIP.some((re) => re.test(toPosixPath(ADMIN)))).toBe(true);
    if (sep !== "/") {
      expect(SKIP.some((re) => re.test(ADMIN))).toBe(false);
    }
  });

  it("an expected-value assertion on a relative path holds on either separator", () => {
    // recover-sol-banner-no-resume-followups asserts exactly this list.
    const hits = [["lib", "wizard-storage.ts"].join(sep)].map(toPosixPath);
    expect(hits).toEqual(["lib/wizard-storage.ts"]);
  });
});

describe("the guards that need the helpers actually use them", () => {
  // Narrow on purpose: only the files whose scan is newline- or separator-sensitive. A new
  // guard of either shape added without the helper is the thing this catches.
  const NEEDS_READ_SOURCE = [
    "api/confirm-transaction-checked.test.ts",
    "lib/limits/no-nocpi-on-p3.test.ts",
    "lib/indexer-db-network-scope.test.ts",
    "lib/touch-input-font-size.test.ts",
    "components/create-market-cancel-on-unmount.test.ts",
    "lib/launch-recovery.test.ts",
    "lib/banned-terms-jsx-guard.test.ts",
  ];
  const NEEDS_TO_POSIX = [
    "api/confirm-transaction-checked.test.ts",
    "lib/banned-terms-jsx-guard.test.ts",
    "components/recover-sol-banner-no-resume-followups.test.tsx",
    "lib/limits/no-nocpi-on-p3.test.ts",
  ];
  const read = (rel: string) => readSource(join(__dirname, "..", rel));

  it("every newline-sensitive scan reads through readSource(), and none re-reads raw", () => {
    for (const rel of NEEDS_READ_SOURCE) {
      const src = read(rel);
      expect(src, rel).toMatch(/from "(\.\.\/)+helpers\/source-scan"/);
      expect(src, rel).toContain("readSource(");
      // The shipped file a guard asserts on must not come back through a raw utf8 read.
      expect(src.includes('readFileSync(f, "utf8")'), `${rel}: raw scan read`).toBe(false);
    }
  });

  it("every path comparison goes through toPosixPath()", () => {
    for (const rel of NEEDS_TO_POSIX) {
      expect(read(rel), rel).toContain("toPosixPath(");
    }
  });

  it("NEGATIVE CONTROL: the file list is real (a typo here would pass vacuously)", () => {
    expect(() => read("lib/this-guard-does-not-exist.test.ts")).toThrow();
    for (const rel of [...NEEDS_READ_SOURCE, ...NEEDS_TO_POSIX]) {
      expect(read(rel).length, rel).toBeGreaterThan(200);
    }
  });
});
