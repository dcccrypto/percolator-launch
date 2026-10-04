/**
 * Structural guard for the entry-price rollout (#2660 / #2671 / #2673).
 *
 * `entry-price-surfaces.test.tsx` renders the surfaces #2660 fixed. It cannot
 * see a NEW surface added next month with another spelling of "may I show this
 * entry?" — which is how #2660 arrived: several surfaces each re-derived that
 * decision and two got it wrong, in opposite directions.
 *
 * The surface list is DISCOVERED by walking the tree for a user-visible "Entry"
 * label, not hand-maintained (the #2634 lesson). Adapted from #2671
 * (@0x-SquidSol) onto the lib/entry-price-display helper that landed first.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { describeEntryPrice, displayEntryE6, isEntryKnown } from "@/lib/entry-price-display";
import type { EntryPriceSource } from "@/lib/trading";

const APP_ROOT = path.resolve(__dirname, "../../");

/** Comments are stripped before ANY match: a comment must not satisfy (or trip) an assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => (l.indexOf("//") === -1 ? l : l.slice(0, l.indexOf("//"))))
    .join("\n");
}

function walkTsx(onFile: (rel: string, src: string) => void): void {
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "__tests__") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx")) {
        onFile(path.relative(APP_ROOT, full).split(path.sep).join("/"), stripComments(fs.readFileSync(full, "utf8")));
      }
    }
  };
  for (const r of ["components", "app"]) walk(path.resolve(APP_ROOT, r));
}

/** A user-visible "Entry" / "Entry Price" label — i.e. a surface that SHOWS one. */
const ENTRY_LABEL = /(>\s*Entry(\s+Price)?\s*<|"Entry(\s+Price)?"|Entry:\s*<\/span>|>Entry:\s)/;

function discoverEntrySurfaces(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  walkTsx((rel, src) => {
    if (ENTRY_LABEL.test(src)) found.push([rel, src]);
  });
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

const SURFACES = discoverEntrySurfaces();

/** Surfaces with an "Entry" label that do not owe the position-entry gate — each with a reason. */
const EXEMPT: Record<string, string> = {
  "components/trade/AccountsCard.tsx":
    "Renders pre-v17 accounts only: SlabProvider hands it `accounts: []` on a v17 market and fills it " +
    "from parseAllAccounts otherwise, where entry_price IS decoded from chain — so `entryPrice > 0n` is a " +
    "real test there, not the structural zero it is on v17.",
  "components/trade/OrderTicket.tsx":
    "Its 'Entry' DiffRow is the PROJECTED fill for the order about to be placed, not a held position's " +
    "recovered entry. The held entry it passes to the Close panel is checked by the call-site guard below.",
  "components/trade/TradingChart.tsx":
    "Draws an entry LINE (no row/cell) from a cached entry or a PnL-derived one; source 'unknown' draws " +
    "no line at all — an absent line makes no claim and never falls back to the mark. The call-site check " +
    "below pins that its line goes through displayEntryE6 (#2990).",
};

describe("the entry-price surface list is discovered, not hand-maintained", () => {
  it("finds the surfaces that show an entry price", () => {
    // CONTROL: a broken walk or predicate yields [] and every check below passes vacuously.
    const names = SURFACES.map(([n]) => n);
    expect(names).toEqual(
      expect.arrayContaining([
        "components/dashboard/PositionSummary.tsx",
        "components/portfolio/PortfolioPositionsView.tsx",
        "components/trade/PositionsDock.tsx",
        "components/trade/PositionPanel.tsx",
        "components/trade/OtherMarketPositions.tsx",
      ]),
    );
    // Pinned exactly: adding a surface must fail here and get a reviewed edit.
    expect(names.length).toBe(8);
  });

  it("every exemption still names a discovered surface, with a real reason", () => {
    const names = new Set(SURFACES.map(([n]) => n));
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(names).toContain(name);
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

describe("no surface formats the RAW on-chain entry price", () => {
  it.each(SURFACES)("%s does not format account.entryPrice", (_name, src) => {
    // v17/v18 hard-code `entryPrice: 0n`; formatting it renders a dash forever
    // (#2660 defect 1). Reading it to FEED resolveEntryPrice is fine.
    expect(src).not.toMatch(/format\w*\(\s*[\w?.]*account[\w?.]*\.entryPrice/);
  });
});

describe("every entry-price readout gates on whether the entry resolved", () => {
  const CELLS = SURFACES.filter(([n]) => !EXEMPT[n]);

  it("there is something left to check after exemptions", () => {
    expect(CELLS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(CELLS)("%s uses one of the two approved shapes", (_name, src) => {
    // A — the shared helper (text AND boolean): describeEntryPrice(...) → {entryDisplay.text}
    // B — the trade-terminal gate whose unknown branch is an InfoIcon / "--":
    //     {pnlIsKnown ? formatUsdPriceE6(entryPriceE6) : ...}
    const usesHelper = /describeEntryPrice\(/.test(src) && /\{\s*\w*[eE]ntryDisplay\.text\s*\}/.test(src);
    const usesExplicitGate =
      /pnlIsKnown\s*(&&[^?]*)?\?\s*format\w*\(/.test(src) &&
      /([sS]ource\s*!==\s*"unknown"|isEntryKnown\()/.test(src);
    expect(usesHelper || usesExplicitGate).toBe(true);
  });
});

describe("the helper is an ALLOWLIST (#2671)", () => {
  const ENTRY = 19_400n;
  it.each<[EntryPriceSource]>([["cache"], ["derived"]])("%s → known", (source) => {
    expect(isEntryKnown(ENTRY, source)).toBe(true);
    expect(displayEntryE6(ENTRY, source)).toBe(ENTRY);
  });

  it.each([["unknown"], [undefined], [null], ["onchain"]])(
    "source=%s → unknown: the mark is never shown as the entry",
    (source) => {
      const s = source as unknown as EntryPriceSource;
      expect(isEntryKnown(ENTRY, s)).toBe(false);
      expect(displayEntryE6(ENTRY, s)).toBe(0n);
      const d = describeEntryPrice({ entryE6: ENTRY, source: s });
      expect(d.known).toBe(false);
      expect(d.text).toBe("—");
    },
  );

  it("over-correction control: a trusted source still shows its number", () => {
    expect(describeEntryPrice({ entryE6: ENTRY, source: "cache", formatPrice: (e) => `P${e}` }).text).toBe("P19400");
  });

  it("a non-positive entry is never shown even with a trusted source", () => {
    expect(isEntryKnown(0n, "derived")).toBe(false);
    expect(isEntryKnown(-5n, "cache")).toBe(false);
    expect(isEntryKnown(undefined, "cache")).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * #2673 — per-CALL, not per-file, and not keyed on an "Entry" label.
 *
 * The discovered-surface check above has two holes #2673 measured: it is
 * per-FILE (an unrelated gated cell satisfies it — ungating OtherMarketPositions'
 * Entry cell left it green), and it only sees files with an "Entry" label
 * (ClosePositionModal says "… at $x entry"). The checks below scan EVERY .tsx
 * under components/ and app/ and look at each formatter / modal call itself.
 * ──────────────────────────────────────────────────────────────────────────── */

const ALL_TSX: Array<[string, string]> = [];
walkTsx((rel, src) => ALL_TSX.push([rel, src]));

/**
 * Components that receive an entry as a PROP under the "0n = unknown"
 * convention (65d8cfd5): inside them `entry > 0n` IS the gate, because every
 * call site is required (below) to pass a gated value.
 */
const ZERO_CONVENTION = new Set([
  "components/trade/ClosePositionForm.tsx",
  "components/trade/ClosePositionModal.tsx",
  "components/trade/OrderTicketClosePanel.tsx",
]);

const KNOWN_FLAG = /^\s*(pnlIsKnown|\w*[eE]ntryKnown|isEntryKnown\(|[\w.]*\.known)\b/;
const ZERO_GATE = /^\s*[\w.]*[eE]ntry\w*\s*>\s*0n\s*$/;

/** The condition of the nearest enclosing `{cond ? … }` JSX/TS expression, up to 3 levels out. */
function enclosingConditions(src: string, at: number): string[] {
  const conds: string[] = [];
  let depth = 0;
  for (let i = at - 1, levels = 0; i >= 0 && levels < 3 && at - i < 600; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        levels++;
        const head = src.slice(i + 1, at);
        const q = head.indexOf("?");
        if (q !== -1) conds.push(head.slice(0, q));
      } else depth--;
    }
  }
  return conds;
}

/** Every formatter call on an entry-named value, anywhere in the tree. */
const ENTRY_FORMAT = /format\w*\(\s*([\w?.]*[eE]ntry[\w?.]*)\s*\)/g;
const FORMAT_EXEMPT: Record<string, string> = {
  "components/trade/OrderTicket.tsx|estEntry": "projected fill for the order being placed, not a held entry",
  "components/trade/AccountsCard.tsx|row.entryPrice": "pre-v17 accounts only; entry_price decoded from chain there",
  "components/share/PnlShareCard.tsx|v.avgEntryUsd":
    "Pure presentation: v.avgEntryUsd is derived from the already-resolved entryE6 its callers pass, " +
    "and the Share-PnL button only renders for a gated position — PositionsDock passes it only when " +
    "`pnlIsKnown && resolvedEntryPrice > 0n` (a cached entry), PortfolioPositionsView only when `entryPriceSource === \"cache\"` — " +
    "so the card never shows a mark as the entry (it never reads account.entryPrice).",
};

describe("#2673: every formatted entry sits under a resolved-entry gate (per call)", () => {
  const calls: Array<{ file: string; arg: string; conds: string[] }> = [];
  for (const [file, src] of ALL_TSX) {
    for (const m of src.matchAll(ENTRY_FORMAT)) {
      calls.push({ file, arg: m[1], conds: enclosingConditions(src, m.index ?? 0) });
    }
  }

  it("inventory is pinned (a new entry readout fails here until reviewed)", () => {
    expect(calls.map((c) => `${c.file}|${c.arg}`).sort()).toEqual([
      "components/share/PnlShareCard.tsx|v.avgEntryUsd",
      "components/trade/AccountsCard.tsx|row.entryPrice",
      "components/trade/ClosePositionForm.tsx|entryPrice",
      "components/trade/OrderTicket.tsx|estEntry",
      "components/trade/OtherMarketPositions.tsx|entryE6",
      "components/trade/PositionPanel.tsx|entryPriceE6",
      "components/trade/PositionsDock.tsx|entryPriceE6",
    ]);
  });

  it.each(calls.map((c) => [`${c.file} format(${c.arg})`, c] as const))("%s", (_label, c) => {
    if (FORMAT_EXEMPT[`${c.file}|${c.arg}`]) return;
    const gated = c.conds.some(
      (cond) => KNOWN_FLAG.test(cond) || (ZERO_CONVENTION.has(c.file) && ZERO_GATE.test(cond)),
    );
    expect(gated, `conditions seen: ${JSON.stringify(c.conds)}`).toBe(true);
  });
});

/** `<Component … prop={expr}` → expr (balanced braces). */
function jsxPropValues(src: string, component: string, prop: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${component}\\b`, "g");
  for (const m of src.matchAll(open)) {
    const start = m.index ?? 0;
    const end = src.indexOf("/>", start);
    const el = src.slice(start, end === -1 ? undefined : end);
    const p = el.indexOf(`${prop}={`);
    if (p === -1) {
      out.push("<missing>");
      continue;
    }
    let depth = 0;
    let i = p + prop.length + 1;
    const from = i + 1;
    for (; i < el.length; i++) {
      if (el[i] === "{") depth++;
      else if (el[i] === "}" && --depth === 0) break;
    }
    out.push(el.slice(from, i).trim());
  }
  return out;
}

const GATED_ENTRY_EXPR = /^(displayEntryE6\(|(pnlIsKnown|\w*[eE]ntryKnown)\s*\?)/;

describe("#2673: the close dialog is handed a gated entry at EVERY call site", () => {
  // ClosePositionModal is the one entry readout attached to an irreversible
  // action, and it has no `source` prop: it trusts `entryPrice > 0n`. So every
  // caller must pass the resolved entry only when it resolved (0n otherwise).
  const sites: Array<{ file: string; expr: string }> = [];
  for (const [file, src] of ALL_TSX) {
    for (const expr of jsxPropValues(src, "ClosePositionModal", "entryPrice")) sites.push({ file, expr });
    for (const expr of jsxPropValues(src, "ClosePositionForm", "entryPrice")) sites.push({ file, expr });
    for (const expr of jsxPropValues(src, "OrderTicketClosePanel", "entryPriceE6")) sites.push({ file, expr });
  }

  it("call-site inventory is pinned", () => {
    expect(sites.map((s) => s.file).sort()).toEqual([
      "components/portfolio/PortfolioPositionsView.tsx",
      "components/trade/ClosePositionModal.tsx",
      "components/trade/OrderTicket.tsx",
      "components/trade/OrderTicketClosePanel.tsx",
      "components/trade/OtherMarketPositions.tsx",
      "components/trade/PositionPanel.tsx",
      "components/trade/PositionsDock.tsx",
    ]);
  });

  it.each(sites.map((s) => [`${s.file}: ${s.expr}`, s] as const))("%s", (_label, s) => {
    // A ZERO_CONVENTION component may forward its own (already-gated) prop.
    const forwarded = ZERO_CONVENTION.has(s.file) && /^[\w]*[eE]ntry\w*$/.test(s.expr);
    expect(GATED_ENTRY_EXPR.test(s.expr) || forwarded, s.expr).toBe(true);
  });
});

describe("CONTROL: the per-call scanners are not vacuous", () => {
  it("an ungated formatter is caught (the #2673 OtherMarketPositions mutant)", () => {
    const src = `<td title={pnlIsKnown ? undefined : TIP}>{formatUsdPriceE6(entryE6)}</td>`;
    const at = src.indexOf("formatUsdPriceE6");
    expect(enclosingConditions(src, at).some((c) => KNOWN_FLAG.test(c))).toBe(false);
    const ok = `<td>{pnlIsKnown && entryE6 > 0n ? formatUsdPriceE6(entryE6) : "--"}</td>`;
    expect(enclosingConditions(ok, ok.indexOf("formatUsdPriceE6")).some((c) => KNOWN_FLAG.test(c))).toBe(true);
  });

  it("an ungated modal prop is caught", () => {
    const [expr] = jsxPropValues(`<ClosePositionModal entryPrice={pos.effectiveEntryPrice} onCancel={x} />`, "ClosePositionModal", "entryPrice");
    expect(expr).toBe("pos.effectiveEntryPrice");
    expect(GATED_ENTRY_EXPR.test(expr)).toBe(false);
  });
});

describe("TradingChart's exempt Entry line still goes through the display allowlist (#2990)", () => {
  it("derives entryPriceNum from displayEntryE6(resolvedEntry.entry, resolvedEntry.source)", () => {
    const src = fs.readFileSync(path.join(APP_ROOT, "components/trade/TradingChart.tsx"), "utf8");
    const block = src.slice(src.indexOf("const entryPriceNum = (() => {"));
    expect(block.length).toBeGreaterThan(0);
    const body = block.slice(0, block.indexOf("})();"));
    expect(body).toMatch(/displayEntryE6\(\s*resolvedEntry\.entry,\s*resolvedEntry\.source,?\s*\)/);
    // The returned number comes from the allowlisted value, never resolvedEntry.entry directly.
    expect(body).toMatch(/return displayEntry > 0n\s*\?\s*Number\(displayEntry\)/);
  });
});
