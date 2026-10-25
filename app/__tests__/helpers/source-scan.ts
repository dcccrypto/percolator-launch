/**
 * OS-portable primitives for the source-SCANNING guard tests — the ones that read a shipped
 * file off disk and assert something about its text (no NoCpi encoder anywhere, every
 * confirmTransaction result checked, the wizard storage key defined once, …).
 *
 * Those guards are the repo's defence against the NEXT call site, so they have to mean the
 * same thing on every contributor's machine. Two assumptions in them were silently
 * platform-specific, and both fail on a Windows checkout (git's default
 * `core.autocrlf=true`), where `pnpm test` reports 11 failures in 8 files with nothing wrong
 * in the code:
 *
 *  1. LINE ENDINGS. A pattern written against `\n` does not match CRLF text, and the miss is
 *     never a clean "no match" — it changes what the guard concludes:
 *       - `line.replace(/\/\/.*$/, "")` strips nothing, because `.` does not match `\r` and
 *         `$` (no `m` flag) does not assert before one. Every prose mention of the banned
 *         symbol then counts as code — a FALSE POSITIVE
 *         (`__tests__/api/confirm-transaction-checked.test.ts` flagged
 *         `hooks/useCreateMarket.ts:2726`, which is a comment).
 *       - `css.indexOf("@media (pointer: coarse) {\n  input:not(")` returns -1, and the
 *         slice built from it is garbage the browser refuses as a selector.
 *     `readSource()` is the one read: it normalises CRLF (and lone CR) to LF, so a guard's
 *     pattern describes the file's CONTENT, never the checkout's line-ending style. Line
 *     count is preserved, so reported line numbers stay correct.
 *
 *  2. PATH SEPARATORS. `path.join` / `path.relative` emit `\` on Windows, so a `/`-spelled
 *     comparison or skip-list stops matching. Here too the failure is not symmetric:
 *     `banned-terms-jsx-guard`'s `SKIP = [/\/admin\//, /\/api\//, …]` matched nothing, the
 *     operator-only admin pages and the API routes were swept after all, and the guard
 *     reported 8 hits in files §5.1 does not cover. A skip-list that silently stops
 *     applying is the same mechanism that would make a guard pass vacuously.
 *     `toPosixPath()` is applied before any comparison, so the guard sees one spelling.
 *
 * Both helpers are no-ops on Linux and macOS: CI's result does not change, which is the
 * point — the guards keep their current meaning and gain a machine-independent one.
 */
import { readFileSync } from "node:fs";
import { sep } from "node:path";

/** CRLF and lone CR to LF. Line COUNT is unchanged, so line numbers derived from the
 *  result still point at the right line of the real file. */
export function normalizeNewlines(src: string): string {
  return src.replace(/\r\n?/g, "\n");
}

/** Read a source file for scanning: UTF-8, newline-normalised. */
export function readSource(file: string): string {
  return normalizeNewlines(readFileSync(file, "utf8"));
}

/** A filesystem path with `/` separators, whatever `path.sep` is here. Use it on BOTH
 *  sides of any path comparison, skip-list test or expected-value assertion. */
export function toPosixPath(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
