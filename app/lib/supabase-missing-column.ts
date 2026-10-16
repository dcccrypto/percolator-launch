/**
 * GH#2408: several routes retry a Supabase query without its `network` filter
 * when the column is missing (migration 20260329180000 not applied). Matching
 * the error message for the word "network" also caught transient errors such
 * as "network timeout" or "NetworkError", so a passing outage served rows from
 * every cluster. Only Postgres undefined_column (42703) naming the column, or
 * PostgREST's schema-cache miss (PGRST204), counts as "column missing".
 */
export function isMissingColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  column: string,
): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  const message = error.message ?? "";
  return new RegExp(`(^|[^A-Za-z0-9_])${column}([^A-Za-z0-9_]|$)`).test(message);
}
