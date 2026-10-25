// @vitest-environment node
/**
 * UX WP-10 AC6 (audit §5.1 / §6): the banned-terms sweep over what the app RENDERS. Every JSX text
 * node and every visible string attribute (title, tooltip, placeholder, aria-label, label,
 * description, text) in app/ and components/ is checked against the §5.1 vocabulary
 * (__tests__/lib/banned-terms-harvest.ts). The copy tables / resolvers are covered by
 * banned-terms-guard.test.ts; the live route pass is scripts/ux-shots/banned-terms-route-sweep.mjs.
 *
 * Not swept (allowed by §5.1): the operator-only admin pages (components/admin, app/admin), dev
 * chrome (components/dev, app/dev-preview), API routes, and code comments.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readSource, toPosixPath } from "../helpers/source-scan";
import ts from "typescript";
import { BANNED } from "./banned-terms-harvest";

const ROOT = process.cwd();
// Tested against toPosixPath(f): path.join emits a backslash separator on Windows, where a
// "/"-spelled skip stops matching, the operator-only admin pages and the API routes get
// swept after all, and the guard reports 8 hits in files §5.1 does not cover.
const SKIP = [/\/admin\//, /\/dev\//, /dev-preview/, /\/api\//, /__tests__/];

function tsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsx(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Attributes that never render as text. */
const NON_TEXT_ATTR = /^(className|class|href|src|srcSet|key|id|type|role|style|target|rel|fill|stroke|d|viewBox|xmlns|name|value|htmlFor|as|mode|variant|size|tone|side|kind|align|method|action|inputMode|autoComplete|pattern|accept|dir|lang|media|sizes|loading|decoding|referrerPolicy|crossOrigin|strokeLinecap|strokeLinejoin|strokeWidth|fillRule|clipRule|gradientUnits|transform|points|x|y|cx|cy|r|rx|ry|width|height|offset|stopColor|preserveAspectRatio|prefix|suffix|icon|slab|symbol|mintAddress|mainnetCa|highlight|data|testId|legacyTestId|data-.*|aria-(?!label).*|on[A-Z].*)$/;

/**
 * Visible strings of a .tsx source, parsed with the TypeScript compiler (comments never count):
 * every JSX text node, every string literal / template text given to a JSX attribute that can
 * render (title, tooltip, desc, label, placeholder, aria-label, …), and every string literal
 * inside a JSX expression container ({cond ? "a" : "b"}).
 */
export function visibleStrings(src: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile("x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { line: number; text: string }[] = [];
  const push = (n: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (/[A-Za-z]/.test(t)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: t });
  };
  const strings = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return; // an object key
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) push(n, n.text);
    else if (ts.isTemplateExpression(n)) push(n, [n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join(" "));
    else if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) visit(n);
    else if (ts.isCallExpression(n)) return; // arguments are code (keys, formats), not copy
    else if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) return; // comparisons
    else ts.forEachChild(n, strings);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) push(n, n.text);
    else if (ts.isJsxAttribute(n)) {
      const name = n.name.getText(sf);
      if (!NON_TEXT_ATTR.test(name) && n.initializer) strings(n.initializer);
      return;
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      strings(n.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The §5.1 list, except that "Portfolio" is also the NAME of a page (nav, page title, "Portfolio
 * value"); only the account sense is banned here ("portfolio account", plural "portfolios").
 */
const JSX_BANNED: [string, RegExp][] = [
  ...BANNED.filter(([t]) => t !== "portfolio" && t !== "LP"),
  // rendered text is often upper-cased by CSS, so "lp" in source is "LP" on screen
  ["LP", /\bLPs?\b/i],
  ["portfolio (account)", /\bportfolio accounts?\b|\bportfolios\b/i],
];

function hits(src: string): string[] {
  const r: string[] = [];
  for (const v of visibleStrings(src)) for (const [term, re] of JSX_BANNED) if (re.test(v.text)) r.push(`${v.line} [${term}] ${v.text.slice(0, 120)}`);
  return r;
}

describe("§5.1 banned terms in rendered JSX (AC6 source sweep)", () => {
  const files = [...tsx(join(ROOT, "app")), ...tsx(join(ROOT, "components"))].filter((f) => !SKIP.some((re) => re.test(toPosixPath(f))));
  it("covers the app (never a vacuous pass)", () => {
    const n = files.reduce((a, f) => a + visibleStrings(readSource(f)).length, 0);
    expect(files.length).toBeGreaterThan(200);
    expect(n).toBeGreaterThan(1_000); // 1,305 visible strings in 230 files at 2026-09-30
  });
  it("no banned term in any user-visible JSX text or attribute", () => {
    const all: string[] = [];
    for (const f of files) for (const h of hits(readSource(f))) all.push(`${toPosixPath(relative(ROOT, f))}:${h}`);
    expect(all).toEqual([]);
  });
  it("NEGATIVE CONTROL: the sweep finds text nodes and attributes, and ignores comments", () => {
    const src = `
      // the LP comment is fine
      /* the keeper comment is fine */
      const a = <div>
        <p title="Paid to the LP">x</p>
        <span>Withdraw in 1,000 slots</span>
        <Row tooltip="the matcher quote" desc={"Redeem LP tokens"} className="LP-row" />
        <span>// insurance lp</span>
        <p>{ok ? "fine" : "the keeper moves it"}</p>
        <b>{fmt("slab")}</b>
      </div>;`;
    const h = hits(src).map((x) => x.replace(/^\d+ /, ""));
    expect(h).toEqual([
      "[LP] Paid to the LP",
      "[slot] Withdraw in 1,000 slots",
      "[matcher] the matcher quote",
      "[LP] Redeem LP tokens",
      "[LP] // insurance lp",
      "[keeper] the keeper moves it",
    ]);
  });
});
