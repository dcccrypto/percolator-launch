import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PnlHistoryCard } from "@/components/dashboard/pnl-history/PnlHistoryCard";

const source = readFileSync(
  resolve(process.cwd(), "app/trader/[wallet]/page.tsx"),
  "utf8",
);

const ast = ts.createSourceFile(
  "trader-page.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const cards: ts.JsxSelfClosingElement[] = [];

function visit(node: ts.Node): void {
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(ast) === "PnlHistoryCard"
  ) {
    cards.push(node);
  }

  ts.forEachChild(node, visit);
}

visit(ast);

describe("Trader Profile PnL History integration", () => {
  it("parses the trader profile and mounts one history card", () => {
    expect(ast.parseDiagnostics).toHaveLength(0);
    expect(cards).toHaveLength(1);
  });

  it("requires explicit trader history opt-in", () => {
    expect(cards).toHaveLength(1);

    let current: ts.Node | undefined = cards[0];
    let gate: ts.BinaryExpression | undefined;

    while (current) {
      if (
        ts.isJsxExpression(current) &&
        current.expression &&
        ts.isBinaryExpression(current.expression) &&
        current.expression.operatorToken.kind ===
          ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        gate = current.expression;
        break;
      }

      current = current.parent;
    }

    expect(gate).toBeDefined();

    if (!gate) {
      throw new Error("Trader History feature gate missing");
    }

    const condition = gate.left
      .getText(ast)
      .replace(/\s+/g, "");

    expect(condition).toBe(
      'process.env.NEXT_PUBLIC_ENABLE_TRADER_PNL_HISTORY==="1"',
    );
  });

  it("keeps history between Trade Stats and Open Positions", () => {
    const stats = source.indexOf("<TradeStatsPanel");
    const history = source.indexOf("<PnlHistoryCard");
    const positions = source.indexOf(
      ">open positions</SectionLabel>",
    );

    expect(stats).toBeGreaterThanOrEqual(0);
    expect(history).toBeGreaterThan(stats);
    expect(positions).toBeGreaterThan(history);

    expect(source).toContain(">markets created</SectionLabel>");
    expect(source).toContain(">trade history</SectionLabel>");
  });

  it("uses unavailable history without demo data", () => {
    expect(cards).toHaveLength(1);

    const card = cards[0].getText(ast);

    expect(card).toMatch(
      /data=\{\{\s*kind:\s*"unavailable"\s*\}\}/,
    );

    expect(source).not.toContain("LOCAL_PNL_HISTORY_FIXTURE");
  });

  it("renders unavailable history without fabricated PnL", () => {
    render(
      <PnlHistoryCard
        data={{ kind: "unavailable" }}
        initialMonth="2026-10"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /History unavailable/i,
    );

    expect(screen.queryByText(/DEMO DATA/i)).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();

    for (const range of [
      "DAILY",
      "WEEKLY",
      "MONTHLY",
      "YEARLY",
    ]) {
      expect(
        screen.getByRole("button", { name: range }),
      ).toBeEnabled();
    }
  });
});
