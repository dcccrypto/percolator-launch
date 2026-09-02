import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #2523 — the canonicaliser's last-resort throw said only "Unsupported market
// registration payload value". Because it is recursive, that one sentence was
// the entire signal for a bad value buried anywhere in the payload.
describe("#2523 payload canonicaliser error is diagnostic", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../lib/market-registration-auth.ts"),
    "utf8",
  );

  it("names the offending type", () => {
    expect(src).toMatch(/type "\$\{typeof value\}"/);
  });

  it("names the likely causes so the message is actionable", () => {
    expect(src).toMatch(/bigint and function values are the usual causes/);
  });

  it("does NOT interpolate the value itself — that would leak payload contents", () => {
    // `${typeof value}` is fine; a bare `${value}` or JSON.stringify(value) in the
    // throw would put user payload into a client-visible error and the logs.
    const thrown = src.slice(src.indexOf("Unsupported market registration payload value"));
    const firstThrowBlock = thrown.slice(0, 400);
    expect(firstThrowBlock).not.toMatch(/\$\{value\}/);
    expect(firstThrowBlock).not.toMatch(/JSON\.stringify\(value\)/);
  });

  it("keeps the sibling non-plain-object error intact", () => {
    expect(src).toMatch(/must contain plain JSON objects/);
  });
});
