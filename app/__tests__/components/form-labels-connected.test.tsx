/**
 * #3141: on /stake, /devnet-mint and in the close form, each <label> sat next to its field without
 * htmlFor / id, so screen readers announced the fields with no name. Labels now point at their
 * field (ids from useId, since the stake page also renders inside /earn and the close form can be
 * open twice).
 */
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

afterEach(cleanup);

const FILES = ["app/stake/page.tsx", "app/devnet-mint/devnet-mint-content.tsx", "components/trade/ClosePositionForm.tsx"];

describe("#3141: form labels are connected to their fields", () => {
  for (const f of FILES) {
    it(`${f}: every <label> has htmlFor, pointing at the field that follows it`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
      const labels = [...src.matchAll(/<label\b([^>]*)>([^<]*)</g)];
      expect(labels.length).toBeGreaterThan(0);
      for (const [i, label] of labels.entries()) {
        const [, attrs, text] = label;
        const m = attrs.match(/htmlFor=\{(.+?)\}(?=\s|$)/);
        expect(m, `label "${text.trim()}"`).not.toBeNull();
        // The first field after this label (before the next label) carries the id.
        const end = labels[i + 1]?.index ?? src.length;
        const field = src.slice(label.index!, end).match(/<(input|select|textarea)\b[\s\S]*?(?:\/>|>)/);
        expect(field?.[0], `field after "${text.trim()}"`).toContain(`id={${m![1]}}`);
      }
    });
  }

  it("the close form's slider is named by its label", () => {
    render(
      <ClosePositionForm
        variant="modal"
        positionSize={80_000_000n}
        entryPrice={99_875_000n}
        currentPrice={100_000_000n}
        capital={1_000_000_000n}
        symbol="TEST"
        decimals={6}
        priceUsd={100}
        isLong
        loading={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const slider = screen.getByLabelText("Close Amount");
    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveAttribute("data-testid", "close-percent-input");
  });
});
