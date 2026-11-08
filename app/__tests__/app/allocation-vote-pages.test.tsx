/**
 * /allocation and /vote pages: truthful unavailable state, no controls that
 * imply working functionality, per-route noindex, host-guarded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let currentHost = "percolator.trade";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: currentHost }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import AllocationPage, { metadata as allocationMeta } from "@/app/allocation/page";
import VotePage, { metadata as voteMeta } from "@/app/vote/page";
import VoteAdminPage, { metadata as adminMeta } from "@/app/vote/admin/page";

const render = async (Page: () => Promise<JSX.Element>) => renderToStaticMarkup(await Page());

beforeEach(() => {
  currentHost = "percolator.trade";
});

describe("/allocation", () => {
  it("states the published terms and offers a one-wallet form, with no holder data in the page", async () => {
    const html = await render(AllocationPage);
    expect(html).toContain("guaranteed floor of 20% of the full $250,000 raise ($50,000), split in proportion to snapshot balance");
    expect(html).toContain("the excess commitment is refunded");
    expect(html).toContain("All figures are provisional until the raise.");
    expect(html).toContain("Paste one Solana wallet address. Only that wallet is looked up.");
    expect(html.match(/<input/gi)).toHaveLength(1);
    expect(html).toMatch(/<form/i);
    // nothing wallet-shaped or figure-shaped beyond the published terms
    expect(html).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    expect(html.replace(/\$250,000|\$50,000|20%/g, "")).not.toMatch(/\$\s?\d|\d[\d,]{4,}/);
    expect(html).not.toMatch(/<textarea|type="file"|multiple/i);
  });

  it("does not conflate the floor with a cap or a reserve release, and names no version", async () => {
    const html = await render(AllocationPage);
    expect(html).not.toMatch(/\bcap\b|capped|maximum|reserve|releas|v2\.2|\bbuild\b|—/i);
  });

  it("is noindex, nofollow", () => {
    expect(allocationMeta.robots).toMatchObject({ index: false, follow: false, googleBot: { index: false, follow: false } });
  });
});

describe("/vote", () => {
  it("states the rules; server HTML has no vote control (state is loaded from the server API)", async () => {
    const html = await render(VotePage);
    expect(html).toContain("Votes are weighted by snapshot balance");
    expect(html).toContain("A tie or no votes means buy and burn.");
    expect(html).toContain("It is not a transaction, costs nothing and moves no");
    expect(html).toContain("Loading vote status");
    expect(html).not.toMatch(/<form|<input|<button|<textarea/i);
    expect(html).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  });

  it("is noindex, nofollow (admin page too)", () => {
    expect(voteMeta.robots).toMatchObject({ index: false, follow: false, googleBot: { index: false, follow: false } });
    expect(adminMeta.robots).toMatchObject({ index: false, follow: false, googleBot: { index: false, follow: false } });
  });

  it("admin page holds no secret: one password field, nothing prefilled", async () => {
    const html = await render(VoteAdminPage);
    expect(html.match(/type="password"/g)).toHaveLength(1);
    expect(html).not.toMatch(/value="[^"]+"/);
  });
});

describe("copy stays minimal", () => {
  it.each([VotePage, VoteAdminPage])("vote pages: no raise figures, dollar amounts, or em dashes", async (Page) => {
    const html = await render(Page);
    expect(html).not.toMatch(/\$|raise|USD|—/i);
  });
});

describe("pages 404 on any other host", () => {
  it.each(["mainnet.percolatorlaunch.com", "percolator-launch.vercel.app", "localhost", "percolator.trade.evil.com", ""])(
    "%s",
    async (host) => {
      currentHost = host;
      await expect(AllocationPage()).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(VotePage()).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(VoteAdminPage()).rejects.toThrow("NEXT_NOT_FOUND");
    },
  );
});
