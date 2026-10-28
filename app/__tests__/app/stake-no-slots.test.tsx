/**
 * UX WP-9 AC5 (audit §3.14, ST-1): the Stake page never shows "slots". Grep: no user-visible string
 * or JSX text in the page mentions a slot. Render: every cooldown string the page renders comes
 * from STAKE_COPY / cooldownDuration, rendered here across the cooldown range.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { STAKE_COPY, cooldownDuration } from "@/lib/stake-copy";

const SRC = fs.readFileSync(path.resolve(__dirname, "../../app/stake/page.tsx"), "utf8");
/** String literals, template literals and JSX text nodes (identifiers like cooldownSlots are none of these). */
const visible = (src: string): string[] => [
  ...(src.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`/g) ?? []),
  ...(src.match(/>[^<>{}\n]*[A-Za-z][^<>{}\n]*</g) ?? []),
];

describe("AC5: no slots in the Stake DOM", () => {
  it("grep: no visible string mentions a slot", () => {
    const hits = visible(SRC.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")).filter((s) => /\bslots?\b/i.test(s));
    expect(hits).toEqual([]);
  });
  it("render: the cooldown strings read as time", () => {
    for (const slots of [0, 50, 150, 900, 9_000, 216_000, 2_000_000]) {
      const { container, unmount } = render(
        <div>
          <p>{STAKE_COPY.availableIn(slots)}</p>
          <p>{STAKE_COPY.period(slots)}</p>
          <p>{cooldownDuration(slots)}</p>
        </div>,
      );
      expect(container.textContent).not.toMatch(/slot/i);
      unmount();
    }
    expect(STAKE_COPY.availableIn(300)).toBe("Withdraw available in 2 min");
    expect(STAKE_COPY.ready).toBe("Ready");
    // Product review 2026-10-28: the sidebar line now comes through stakeCopy() (v2.2 wording when the flag is on).
    expect(SRC).toContain("desc={copy.sidebar}");
    expect(SRC).toContain("const copy = stakeCopy();");
    expect(SRC).not.toContain("Redeem LP tokens");
  });
});
