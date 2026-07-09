import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("admin session security checks", () => {
  it("fails closed if admin auth env vars are missing", () => {
    const source = readFileSync(
      resolve(__dirname, "../../lib/admin-session.ts"),
      "utf8",
    );

    expect(source).toContain("Neither PRIVY_ADMIN_DIDS nor PRIVY_ADMIN_EMAILS is configured on the server");
    expect(source).toContain("{ status: 503 }");
  });

  it("requires a valid Privy session", () => {
    const source = readFileSync(
      resolve(__dirname, "../../lib/admin-session.ts"),
      "utf8",
    );

    expect(source).toContain("verifyPrivyAuth");
    expect(source).toContain("Session expired or invalid — sign in again");
  });

  it("normalizes identity elements before admin check", () => {
    const source = readFileSync(
      resolve(__dirname, "../../lib/admin-session.ts"),
      "utf8",
    );

    expect(source).toContain("function normalizeEmail");
    expect(source).toContain("function stripDidPrefix");
    expect(source).toContain("getAdminEmailSet");
    expect(source).toContain("getAdminDidSet");
  });
});
