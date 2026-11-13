// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("POST /api/markets duplicate slab guard", () => {
  it("rejects re-registration of an existing slab on active network", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/api/markets/route.ts"),
      "utf8",
    );

    expect(source).toContain(".eq(\"slab_address\", slab_address)");
    expect(source).toContain(".eq(\"network\", insertNetwork)");
    expect(source).toContain("Market already registered for this slab on the active network");
    expect(source).toContain("{ status: 409 }");
  });
});
