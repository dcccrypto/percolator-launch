// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildSolflareBrowseUrl } from "@/lib/solflare";

describe("buildSolflareBrowseUrl", () => {
  it("builds a Solflare browse deep-link with ref", () => {
    const url = buildSolflareBrowseUrl("https://example.com/path?a=1", "https://example.com");
    expect(url).toBe(
      "https://solflare.com/ul/v1/browse/https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1?ref=https%3A%2F%2Fexample.com"
    );
  });
});
