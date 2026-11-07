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

const render = async (Page: () => Promise<JSX.Element>) => renderToStaticMarkup(await Page());

beforeEach(() => {
  currentHost = "percolator.trade";
});

describe("/allocation", () => {
  it("says allocations are not published and offers no checker form", async () => {
    const html = await render(AllocationPage);
    expect(html).toContain("Allocations have not been published yet.");
    expect(html).not.toMatch(/<form|<input|<button|<textarea/i);
  });

  it("is noindex, nofollow", () => {
    expect(allocationMeta.robots).toMatchObject({ index: false, follow: false, googleBot: { index: false, follow: false } });
  });
});

describe("/vote", () => {
  it("says voting is not open and has no start/sign/submit control", async () => {
    const html = await render(VotePage);
    expect(html).toContain("Voting is not open.");
    expect(html).not.toMatch(/<form|<input|<button|<textarea/i);
    expect(html).not.toMatch(/start|sign message|submit/i);
  });

  it("is noindex, nofollow", () => {
    expect(voteMeta.robots).toMatchObject({ index: false, follow: false, googleBot: { index: false, follow: false } });
  });
});

describe("copy stays minimal", () => {
  it.each([AllocationPage, VotePage])("no raise figures, dollar amounts, or em dashes", async (Page) => {
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
    },
  );
});
