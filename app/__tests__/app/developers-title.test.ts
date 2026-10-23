/**
 * #80: the root layout's title template appends " | Percolator", and /developers set
 * "Developers - Percolator", so its tab read "Developers - Percolator | Percolator".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github", () => ({
  getAllRepos: vi.fn(), getContributorStats: vi.fn(), getAllCommitActivity: vi.fn(),
  getGoodFirstIssues: vi.fn(), getAllCIStatuses: vi.fn(), REPOS: [],
}));
vi.mock("@/app/developers/DevelopersClient", () => ({ DevelopersClient: () => null }));

import { metadata } from "@/app/developers/page";

describe("/developers metadata", () => {
  it("gives the template a bare title, so the brand appears once", () => {
    expect(metadata.title).toBe("Developers");
  });

  it("the share title names the brand once", () => {
    expect((metadata.openGraph as { title?: string }).title).toBe("Developers | Percolator");
  });

  it("is canonical to itself, not the inherited home page", () => {
    expect(metadata.alternates?.canonical).toBe("/developers");
  });
});
