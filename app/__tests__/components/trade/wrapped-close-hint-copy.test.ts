/**
 * Follow-up to #3022: every user-facing pointer to the removed Position NFT panel (UX WP-9) now
 * names the row's ⋯ menu, and the dock banner takes its text from NFT_MENU_COPY so it cannot
 * drift from the menu's own Unwrap label again.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { humanizeError } from "@/lib/errorMessages";
import { NFT_MENU_COPY } from "@/components/trade/PositionNftMenu";

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("removed Position NFT panel: no user-facing pointers left", () => {
  it("TokenInvalidMintError copy points at the ⋯ menu's Unwrap, not the panel", () => {
    const msg = humanizeError("TokenInvalidMintError");
    expect(msg).not.toMatch(/NFT panel/i);
    expect(msg).toContain("⋯ menu");
    expect(msg).toContain(NFT_MENU_COPY.unwrap);
  });

  it("the dock banner reads NFT_MENU_COPY.wrappedHint, which names the menu's Unwrap item", () => {
    const dock = read("components/trade/PositionsDock.tsx");
    expect(dock).toContain("{NFT_MENU_COPY.wrappedHint}");
    expect(NFT_MENU_COPY.wrappedHint).toContain(`${NFT_MENU_COPY.unwrap} it from the ⋯ menu`);
    expect(NFT_MENU_COPY.wrappedHint).not.toMatch(/NFT panel/i);
  });
});
