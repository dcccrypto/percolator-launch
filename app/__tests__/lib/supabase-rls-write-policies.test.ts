/**
 * Regression — GH#2499: `supabase/schema.sql` must not define PUBLIC write policies.
 *
 * A PostgreSQL RLS policy with no `TO` clause applies to the PUBLIC pseudo-role,
 * which includes `anon` — the role behind NEXT_PUBLIC_SUPABASE_ANON_KEY. A write
 * policy written that way lets anyone holding the public key INSERT/UPDATE through
 * PostgREST, bypassing every check in the API routes.
 *
 * Scope note: this checks `schema.sql` ONLY, deliberately.
 *
 * The historical migrations under supabase/migrations/ do contain policies of this
 * shape, but each was already dropped by a later migration —
 *   - core financial tables → 20260402180100_drop_stale_core_table_rls_policies
 *   - bug_reports          → 20260402180000_drop_stale_bug_reports_update_policy
 *   - ideas                → 20260330120000_ideas_update_rls_service_role
 *   - job_applications     → 044_fix_admin_users_rls
 * so a database built from the migration chain is not affected. Migrations are
 * immutable history; asserting over them would flag the original CREATE forever and
 * pressure someone into editing an applied migration, which is worse than the thing
 * being prevented.
 *
 * `schema.sql` is different: it is the reference schema still run by hand in the
 * Supabase SQL Editor to bootstrap an environment. Permissive policies are OR'd, so
 * running a version of it that omits `to service_role` re-opens write access
 * alongside the correct policies — precisely what 20260402180100 exists to undo.
 * That file is the live footgun, so that file is what this pins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = resolve(__dirname, "../../../supabase/schema.sql");

/** Strip line comments so a policy quoted inside a comment isn't flagged. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}

/** `create policy … for insert|update|delete|all …` statements, whitespace-normalised. */
function writePolicyStatements(sql: string): string[] {
  return stripComments(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /^create\s+policy/i.test(s))
    .filter((s) => /\bfor\s+(insert|update|delete|all)\b/i.test(s));
}

const sql = readFileSync(SCHEMA, "utf8");
const writePolicies = writePolicyStatements(sql);

describe("supabase/schema.sql write policies are role-scoped", () => {
  it("actually finds write policies (guard against a silently empty sweep)", () => {
    expect(writePolicies.length).toBeGreaterThan(0);
  });

  it("every write policy names a role — none defaults to PUBLIC", () => {
    const unscoped = writePolicies.filter((s) => !/\bto\s+[a-z_]+/i.test(s));
    expect(unscoped).toEqual([]);
  });

  it.each(["markets", "market_stats", "trades", "oracle_prices"])(
    "%s write policies are service_role-scoped",
    (table) => {
      const writes = writePolicies.filter((s) =>
        new RegExp(`\\bon ${table}\\b`, "i").test(s),
      );
      expect(writes.length, `${table} should have write policies`).toBeGreaterThan(0);
      for (const w of writes) {
        expect(w, `${table}: ${w}`).toMatch(/\bto service_role\b/i);
      }
    },
  );

  it("read policies are untouched — public SELECT is intentional here", () => {
    const selects = stripComments(sql)
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => /^create\s+policy/i.test(s) && /\bfor\s+select\b/i.test(s));
    expect(selects.length).toBeGreaterThan(0);
  });
});
