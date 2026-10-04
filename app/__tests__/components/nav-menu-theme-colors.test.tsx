/**
 * #57: the header's Community dropdown and the mobile menu used fixed dark-theme colours
 * (#d1d5db items, #9ca3af labels, #22d3ee current page), so in light mode the items were pale grey
 * on white. They now use the theme tokens; the current page is accent text on the accent tint.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";

vi.mock("next/navigation", () => ({ usePathname: () => "/developers" }));

import { NavDropdown } from "@/components/layout/NavDropdown";

afterEach(cleanup);

const items = [
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/developers", label: "Developers" },
];

describe("#57: header menu colours follow the theme", () => {
  it("dropdown items use the theme text colour; the current page uses the accent", () => {
    render(<NavDropdown label="Community" items={items} />);
    const item = screen.getByRole("menuitem", { name: "Leaderboard", hidden: true });
    const current = screen.getByRole("menuitem", { name: "Developers", hidden: true });
    // Exact classes: the old item class already had `hover:text-[var(--text)]`.
    expect(item.className.split(/\s+/)).toContain("text-[var(--text)]");
    expect(current.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["text-[var(--accent-text)]", "bg-[var(--accent)]/[0.06]"]),
    );
  });

  it("no fixed dark-theme greys or cyan left in the header menus", () => {
    for (const f of ["components/layout/NavDropdown.tsx", "components/layout/Header.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
      expect(src, f).not.toMatch(/#9ca3af|#d1d5db|#22d3ee|rgba\(34,\s*211,\s*238/i);
    }
  });
});
