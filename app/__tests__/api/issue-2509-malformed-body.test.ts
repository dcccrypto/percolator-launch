import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #2509 — omitting `slabAddress` deliberately means "apply to ALL admin-oracle
// markets". The old handler caught a JSON parse failure and left `body = {}`,
// so a truncated or corrupt payload silently widened a single-market change
// into a fleet-wide one. Empty and malformed are different requests.
describe("#2509 set-price-cap distinguishes empty from malformed body", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../app/api/oracle/set-price-cap/route.ts"),
    "utf8",
  );

  it("reads the raw body and only parses when non-empty", () => {
    expect(src).toMatch(/await req\.text\(\)/);
    expect(src).toMatch(/rawBody\.trim\(\)\s*!==\s*""/);
  });

  it("returns 400 on malformed JSON rather than falling through", () => {
    // the parse failure path must produce a 400, not an empty-object default
    const parseCatch = src.slice(src.indexOf("JSON.parse(rawBody)"));
    expect(parseCatch).toMatch(/status:\s*400/);
    expect(parseCatch).toMatch(/Malformed JSON body/);
  });

  it("no longer treats a parse failure as the all-markets default", () => {
    // the old shape: `try { body = await req.json() } catch { /* empty ok */ }`
    expect(src).not.toMatch(/body\s*=\s*await req\.json\(\)/);
  });

  it("rejects a non-object JSON body (array / null) too", () => {
    expect(src).toMatch(/Array\.isArray\(body\)/);
  });
});
