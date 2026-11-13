// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("trusted proxy-aware IPs for rate-limited public endpoints", () => {
  it("stats endpoint uses getClientIp", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/api/stats/route.ts"),
      "utf8",
    );

    expect(source).toContain('import { getClientIp } from "@/lib/get-client-ip"');
    expect(source).toContain("const ip = getClientIp(request);");
    expect(source).not.toContain('x-forwarded-for")?.split(",")[0]');
  });

  it("trader stats endpoint uses getClientIp", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/api/trader/[wallet]/stats/route.ts"),
      "utf8",
    );

    expect(source).toContain('import { getClientIp } from "@/lib/get-client-ip"');
    expect(source).toContain("const ip = getClientIp(request);");
    expect(source).not.toContain('x-forwarded-for")?.split(",")[0]');
  });

  it("trader trades endpoint uses getClientIp", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/api/trader/[wallet]/trades/route.ts"),
      "utf8",
    );

    expect(source).toContain('import { getClientIp } from "@/lib/get-client-ip"');
    expect(source).toContain("const ip = getClientIp(_request);");
    expect(source).not.toContain('x-forwarded-for")?.split(",")[0]');
  });
});
