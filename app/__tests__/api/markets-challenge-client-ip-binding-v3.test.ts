// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("POST /api/markets challenge client-ip binding", () => {
  it("binds nonce claims to the issuing client IP", () => {
    const source = readFileSync(resolve(process.cwd(), "app/api/markets/route.ts"), "utf8");

    expect(source).toContain('import { getClientIp } from "@/lib/get-client-ip";');
    expect(source).toContain('.eq("client_ip", clientIp)');
  });
});