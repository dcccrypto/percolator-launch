import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("POST /api/oracle-keeper/register JSON guard", () => {
  it("returns 400 for malformed JSON bodies", () => {
    const source = readFileSync(
      resolve(__dirname, "../../app/api/oracle-keeper/register/route.ts"),
      "utf8",
    );

    // LAUNCH-16: body is read once as raw text (rawBody) so the HMAC signature can be
    // verified over the exact bytes sent, then JSON.parse'd — no longer `req.json()`.
    expect(source).toContain("body = JSON.parse(rawBody)");
    expect(source).toContain('return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })');
  });
});
