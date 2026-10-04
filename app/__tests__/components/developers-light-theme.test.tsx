/**
 * #58: parts of /developers hardcoded dark-theme colours (near-white headings, white-alpha borders
 * and fills, black/40 code blocks, violet-400 labels, neon repo badges, a white-alpha empty heatmap
 * cell), so in light mode they were invisible or faint. They now use the theme tokens.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { HowToContribute } from "@/components/HowToContribute";
import { RepoHealthBadges } from "@/components/RepoHealthBadges";

afterEach(cleanup);

const FILES = [
  "components/HowToContribute.tsx",
  "app/developers/DevelopersClient.tsx",
  "components/DevnetV2Deployment.tsx",
  "components/CommitHeatmap.tsx",
  "components/RepoHealthBadges.tsx",
];
const DARK_ONLY = new RegExp(
  [
    String.raw`text-\[#f0f0f5\]`,
    String.raw`text-\[#a78bfa\]`,
    String.raw`(border|bg|divide)-white\/`,
    String.raw`bg-black\/`,
    String.raw`text-violet-\d`,
    String.raw`#4ade80|#22d3ee|#fb923c|#f87171`,
    // A bare white rgba; `var(--x, rgba(...))` fallbacks are fine.
    String.raw`(?<!var\(--[\w-]+,\s*)rgba\(255,\s*255,\s*255`,
  ].join("|"),
  "i",
);
const classes = (el: Element) => el.className.split(/\s+/);

describe("#58: /developers follows the theme", () => {
  it("How to contribute headings use the theme text colour", () => {
    render(<HowToContribute contributorCount={3} goodFirstIssues={[]} />);
    expect(classes(screen.getByRole("heading", { name: "How to contribute" }))).toContain("text-[var(--text)]");
    expect(classes(screen.getByRole("heading", { name: "Fork & clone" }))).toContain("text-[var(--text)]");
  });

  it("the Discord button switches to the accent in light mode", () => {
    render(<HowToContribute contributorCount={3} goodFirstIssues={[]} />);
    expect(classes(screen.getByRole("link", { name: /Discord server/ }))).toContain(
      "[[data-theme=light]_&]:text-[var(--accent-text)]",
    );
  });

  it("repo badges take their colour from the theme tokens", () => {
    render(
      <RepoHealthBadges
        license={{ spdx_id: "Apache-2.0" }}
        pushedAt={new Date().toISOString()}
        ciStatus={{ passing: false }}
      />,
    );
    const style = (text: RegExp) => (screen.getByText(text) as HTMLElement).getAttribute("style") ?? "";
    expect(style(/Apache-2\.0/)).toContain("var(--long)");
    expect(style(/Active/)).toContain("var(--accent-text)");
    expect(style(/CI failing/)).toContain("var(--short)");
  });

  it("no dark-only colours left in the page's components", () => {
    for (const f of FILES) {
      const src = fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
      expect(src, f).not.toMatch(DARK_ONLY);
    }
  });
});
