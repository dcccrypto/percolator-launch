/**
 * GH#2503 — the waitlist table must have no anon write path.
 *
 * Every anti-abuse control on signup (referral-code requirement, Turnstile,
 * honeypot, dwell time, disposable-email block, bot-UA filter, per-IP and
 * per-referral-code caps, wallet-signature verification) lives in
 * POST /api/waitlist/signup. That makes the route a security boundary only if
 * it is the ONLY path that can write the table.
 *
 * It was not. The RLS policy read `for insert to anon with check (true)` — an
 * unconditional grant to the role the PUBLISHABLE key maps to — so a direct
 * PostgREST INSERT skipped every control above and could choose `created_at`
 * (waitlist_position orders by created_at ASC, so: position #1), `tier`,
 * `referral_code` and `referred_by_code` (leaderboard fraud).
 *
 * These assertions guard the source in the same style as the sibling
 * waitlist-signup-*.test.ts files, because the property is structural: it is
 * about which credential may write, which no request-level test can observe.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../app/api/waitlist/signup/route.ts",
);
const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../supabase-waitlist-schema.sql",
);

/**
 * Strip `--` line comments before matching statements.
 *
 * This file is mostly prose: it explains the anon/publishable-key model at
 * length, and the GH#2503 note deliberately quotes `create policy ... to anon`
 * to describe the regression it is guarding against. Matching statements
 * against the raw text picks that sentence up as a policy and reads forward to
 * the next `;`, which is how the first version of this test failed. Parse the
 * SQL, not the commentary.
 */
function sqlStatements(schema: string): string[] {
  const code = schema
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return code.match(/create policy[\s\S]*?;/gi) ?? [];
}

describe("GH#2503: waitlist writes are server-only", () => {
  it("grants the waitlist INSERT policy to service_role, not anon", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

    const insertPolicies = sqlStatements(schema).filter((p) =>
      /for\s+insert/i.test(p),
    );

    expect(insertPolicies.length).toBeGreaterThan(0);
    for (const policy of insertPolicies) {
      expect(policy).toMatch(/to\s+service_role/i);
      expect(policy).not.toMatch(/to\s+anon/i);
    }
  });

  it("leaves no INSERT/UPDATE/DELETE policy granted to anon", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const anonWritePolicies = sqlStatements(schema).filter(
      (p) => /to\s+anon/i.test(p) && /for\s+(insert|update|delete)/i.test(p),
    );

    expect(anonWritePolicies).toEqual([]);
  });

  it("inserts through the service-role client, not the publishable one", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");

    // The binding the insert is performed on must come from the service client.
    const insertBinding = source.match(
      /const\s+(\w+)\s*=\s*getWaitlistServiceSupabase\(\);[\s\S]*?await\s+\1\s*\.from\("waitlist"\)\s*\.insert\(/,
    );
    expect(insertBinding).not.toBeNull();

    // And no insert may be performed on a binding built from the anon client.
    const anonInsert = source.match(
      /const\s+(\w+)\s*=\s*getWaitlistSupabase\(\);[\s\S]*?await\s+\1\s*\.from\("waitlist"\)\s*\.insert\(/,
    );
    expect(anonInsert).toBeNull();
  });

  it("still uses the anon client only for the anon-granted RPC", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

    // getWaitlistSupabase() may remain for reads that go through a
    // SECURITY DEFINER function anon is explicitly granted — that is the
    // designed use of the publishable key and is not a write path.
    const anonUses = source.match(/getWaitlistSupabase\(\)\s*\.\s*(\w+)/g) ?? [];
    for (const use of anonUses) {
      expect(use).toMatch(/\.rpc$/);
    }

    // Guard the grant this depends on, so revoking it upstream is not silent.
    expect(schema).toMatch(
      /grant execute on function public\.waitlist_referral_code_exists\(text\) to anon;/,
    );
  });
});
