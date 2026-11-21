import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const code = readFileSync(
  resolve(process.cwd(), "app/dashboard/page.tsx"),
  "utf8",
);

const file = ts.createSourceFile(
  "page.tsx",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const switcher = file.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "PortfolioPnLHistorySwitcher",
);

describe("Portfolio PnL History switcher gate", () => {
  it("does not cap the desktop history wrapper height", () => {
    const wrapper = code.match(
      /<div className="lg:col-span-3"\s+style=\{\{([^}]*)\}\}>\s*<PortfolioPnLHistorySwitcher\s*\/>/
    );

    expect(wrapper).not.toBeNull();
    expect(wrapper?.[1]).toContain("minHeight: 380");
    expect(wrapper?.[1]).not.toContain("maxHeight");
  });

  it("preserves the live chart when the flag is disabled", () => {
    if (!switcher || !ts.isFunctionDeclaration(switcher) || !switcher.body) {
      throw new Error("PnL switcher function missing");
    }

    const statements = switcher.body.statements;

    const stateIndex = statements.findIndex(
      (node) => node.getText(file).includes("useState"),
    );

    const guardIndex = statements.findIndex(
      (node) =>
        ts.isIfStatement(node) &&
        node.expression.getText(file) ===
          "!isPortfolioPnlHistoryEnabled()",
    );

    expect(stateIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThan(stateIndex);

    const guard = statements[guardIndex];

    if (!guard || !ts.isIfStatement(guard)) {
      throw new Error("Feature guard missing");
    }

    const fallback =
      ts.isBlock(guard.thenStatement)
        ? guard.thenStatement.statements.find(ts.isReturnStatement)
        : undefined;

    if (
      !fallback ||
      !ts.isReturnStatement(fallback) ||
      !fallback.expression ||
      !ts.isJsxSelfClosingElement(fallback.expression)
    ) {
      throw new Error("Live PnL fallback missing");
    }

    expect(fallback.expression.tagName.getText(file)).toBe(
      "PnlChart",
    );
  });

  it("keeps both live and history rendering paths", () => {
    if (!switcher || !ts.isFunctionDeclaration(switcher) || !switcher.body) {
      throw new Error("PnL switcher missing");
    }

    const tags: string[] = [];

    function visit(node: ts.Node): void {
      if (ts.isJsxSelfClosingElement(node)) {
        tags.push(node.tagName.getText(file));
      }
      ts.forEachChild(node, visit);
    }

    visit(switcher.body);

    expect(tags).toContain("PnlChart");
    expect(tags).toContain("PnlHistoryCard");

    const body = switcher.body.getText(file);

    expect(body).toContain('aria-label="Portfolio PnL view"');
    expect(body).toContain("setView(option)");
  });

  it("retains desktop and mobile integration", () => {
    let count = 0;

    function visit(node: ts.Node): void {
      if (
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(file) ===
          "PortfolioPnLHistorySwitcher"
      ) {
        count++;
      }

      ts.forEachChild(node, visit);
    }

    visit(file);

    expect(count).toBe(2);
  });
});
