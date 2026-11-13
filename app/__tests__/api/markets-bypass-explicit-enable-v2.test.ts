// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("POST /api/markets explicit bypass opt-in", () => {
  it("requires MARKETS_AUTH_BYPASS_ENABLED=true before bypass is allowed", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/api/markets/route.ts"),
      "utf8",
    );

    expect(source).toContain("const bypassEnabled = process.env.MARKETS_AUTH_BYPASS_ENABLED === \"true\";");
    expect(source).toContain("const isBypass = !isProd && bypassEnabled && bypassSecret && bypassHeader === bypassSecret;");
  });
});
