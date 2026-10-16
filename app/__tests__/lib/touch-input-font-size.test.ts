/**
 * #3305: iOS Safari zooms on focus into a text field under 16px. One unlayered rule under
 * `@media (pointer: coarse)` sets 16px on every text field, select and textarea; pinch-zoom stays on.
 * jsdom has no layout or media evaluation, so this pins the rule, checks its selector against real
 * elements, and scans the source for anything that would out-rank it. The 16px result was also measured
 * in Chromium with iPhone 13 touch emulation (see the PR).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const root = process.cwd();
const css = readFileSync(join(root, "app/globals.css"), "utf8");
const at = css.indexOf("@media (pointer: coarse) {\n  input:not(");
const block = css.slice(at, css.indexOf("\n}\n", at) + 3);
const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
const selector = body.slice(0, body.indexOf("{")).trim();

function field(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}
const hit = (html: string) => field(html).matches(selector);

describe("coarse-pointer 16px field rule", () => {
  it("exists, is 16px, and is not inside a cascade layer (so it beats text-sm / text-[13px])", () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toMatch(/font-size:\s*16px/);
    const before = css.slice(0, at);
    // brace depth 0 at the rule: no @layer (or any block) is open around it
    let depth = 0;
    for (const ch of before) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    expect(depth).toBe(0);
    expect(block).not.toMatch(/!important/);
  });

  it("zoom is not disabled", () => {
    const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/maximumScale|maximum-scale|userScalable|user-scalable/);
  });

  it("matches text fields, selects and textareas at the sizes the issue lists", () => {
    for (const cls of ["text-sm", "text-[13px]", "text-[12px]", "text-[11px]", "text-[10px]", "text-xs", ""]) {
      expect(hit(`<input type="text" class="${cls}">`), `input ${cls}`).toBe(true);
      expect(hit(`<select class="${cls}"></select>`), `select ${cls}`).toBe(true);
      expect(hit(`<textarea class="${cls}"></textarea>`), `textarea ${cls}`).toBe(true);
    }
    expect(hit(`<input class="text-sm">`)).toBe(true);
    expect(hit(`<input type="number" class="text-[13px]">`)).toBe(true);
    expect(hit(`<input type="search">`)).toBe(true);
  });

  it("leaves non-text controls alone", () => {
    for (const t of ["checkbox", "radio", "range", "file", "button", "submit", "hidden"]) {
      expect(hit(`<input type="${t}" class="text-sm">`), t).toBe(false);
    }
  });

  it("never shrinks a field that already sets text-lg or larger (the Earn amount is text-2xl)", () => {
    for (const cls of ["text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl"]) {
      expect(hit(`<input type="text" class="w-full ${cls} font-mono">`), cls).toBe(false);
    }
  });
});

describe("nothing in the source out-ranks the rule on a field", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === "node_modules" || f === "__tests__") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx$/.test(f)) files.push(p);
    }
  };
  walk(join(root, "app"));
  walk(join(root, "components"));

  const tags: { file: string; tag: string }[] = [];
  for (const file of files) {
    const s = readFileSync(file, "utf8");
    for (const m of s.matchAll(/<(input|select|textarea)\b/g)) {
      let i = (m.index ?? 0) + m[0].length;
      let depth = 0;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0 && s[i - 1] !== "=") break;
      }
      tags.push({ file, tag: s.slice(m.index, i + 1) });
    }
  }
  const textual = tags.filter((t) => !/type=["{]\s*"?(checkbox|radio|range|file|hidden|button|submit)/.test(t.tag));

  it("scanned the fields", () => expect(textual.length).toBeGreaterThan(30));
  it("no field sets an inline font-size or an !important size (both beat the rule)", () => {
    expect(textual.filter((t) => /fontSize|font-size|!text-/.test(t.tag)).map((t) => t.file)).toEqual([]);
  });
  it("no field uses an arbitrary size above 16px (the rule would shrink it to 16px)", () => {
    const big = textual.filter((t) => [...t.tag.matchAll(/text-\[(\d+)px\]/g)].some((m) => Number(m[1]) > 16));
    expect(big.map((t) => t.file)).toEqual([]);
  });
});
