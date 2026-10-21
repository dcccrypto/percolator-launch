/**
 * The server-side verdict: may this verified Privy identity enter devnet v2?
 *
 * Shared by POST /api/playground/authorize (which only REPORTS the verdict) and
 * POST /api/playground/enter (which acts on it by minting a handoff token), so
 * the page, the nav tab and the door can never disagree about who is in.
 *
 * Membership and position are the definitions /api/waitlist/whoami already
 * uses — same row resolution order, same "a row without a referral code is not
 * a membership", same position RPCs preferring pubkey then email — so a member
 * reading "#812" on the waitlist page is judged on #812 here.
 *
 * Fails CLOSED. Any lookup error, or a member whose position cannot be read, is
 * `unavailable` — never a grant, and never mislabelled as "not on the list" or
 * "in the queue".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrivyAuthOk } from "@/lib/privy-auth";
import { cohortCutoff, isWithinCohort } from "@/lib/playground-access";

export type PlaygroundVerdict =
  | { kind: "granted"; rowId: string; position: number; cutoff: number; referralCode: string | null }
  | { kind: "not_yet"; position: number; cutoff: number }
  | { kind: "not_member" }
  | { kind: "unavailable" };

type WaitlistRow = {
  id: string;
  pubkey: string | null;
  email: string | null;
  referral_code: string | null;
};
const SELECT = "id, pubkey, email, referral_code, privy_did";

/** Thrown internally so every Supabase error collapses into `unavailable`. */
class LookupError extends Error {}

async function findBy(
  supabase: SupabaseClient,
  column: "privy_did" | "pubkey" | "email",
  value: string,
): Promise<WaitlistRow | null> {
  const { data, error } = await supabase
    .from("waitlist")
    .select(SELECT)
    .eq(column, value)
    .maybeSingle();
  // supabase-js reports failures in `error` rather than throwing. Ignoring it
  // would turn an outage into "we don't see you on the list".
  if (error) throw new LookupError(`waitlist lookup by ${column} failed`);
  const row = data as WaitlistRow | null;
  // whoami's definition of membership: a row only counts once it has a
  // referral code.
  return row?.referral_code ? row : null;
}

/** Case-insensitive exact email match (stored casing varies); LIKE wildcards escaped. */
async function findByEmail(supabase: SupabaseClient, email: string): Promise<WaitlistRow | null> {
  const escaped = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await supabase.from("waitlist").select(SELECT).ilike("email", escaped).limit(1).maybeSingle();
  if (error) throw new LookupError("waitlist lookup by email failed");
  const row = data as WaitlistRow | null;
  return row?.referral_code ? row : null;
}

/** Like whoami: an email/wallet hit stores the Privy DID so the next sign-in matches directly. Best effort. */
async function backfillDid(supabase: SupabaseClient, row: WaitlistRow, did: string): Promise<void> {
  if ((row as { privy_did?: string | null }).privy_did) return;
  try {
    await supabase.from("waitlist").update({ privy_did: did }).eq("id", row.id).is("privy_did", null);
  } catch {
    /* never blocks the verdict */
  }
}

async function resolveRow(supabase: SupabaseClient, auth: PrivyAuthOk): Promise<WaitlistRow | null> {
  const byDid = await findBy(supabase, "privy_did", auth.userId);
  if (byDid) return byDid;
  // FULL arrays: a member who signed up with their second wallet or second
  // email must still resolve.
  for (const pubkey of auth.solanaWallets ?? []) {
    const hit = await findBy(supabase, "pubkey", pubkey);
    if (hit) return hit;
  }
  for (const email of auth.emails ?? []) {
    const hit = await findByEmail(supabase, email);
    if (hit) {
      await backfillDid(supabase, hit, auth.userId);
      return hit;
    }
  }
  return null;
}

async function positionOf(supabase: SupabaseClient, row: WaitlistRow): Promise<number | null> {
  if (row.pubkey) {
    const { data, error } = await supabase.rpc("waitlist_position", { p_pubkey: row.pubkey });
    if (error) throw new LookupError("waitlist_position failed");
    if (typeof data === "number") return data;
  }
  if (row.email) {
    const { data, error } = await supabase.rpc("waitlist_position_by_email", { p_email: row.email });
    if (error) throw new LookupError("waitlist_position_by_email failed");
    if (typeof data === "number") return data;
  }
  return null;
}

/**
 * Decide. Never throws. Logs the Privy DID only — never an email or a pubkey,
 * because logs are the quietest place a waitlist leaks from.
 */
export async function decidePlaygroundAccess(
  auth: PrivyAuthOk,
  getSupabase: () => SupabaseClient,
  cutoff: number = cohortCutoff(),
): Promise<PlaygroundVerdict> {
  try {
    const supabase = getSupabase();
    const row = await resolveRow(supabase, auth);
    if (!row) return { kind: "not_member" };

    const position = await positionOf(supabase, row);
    if (position == null || !Number.isFinite(position) || position < 1) {
      // A member whose position cannot be read is an anomaly, not a verdict.
      console.warn(`[playground-gate] no position for ${auth.userId}`);
      return { kind: "unavailable" };
    }
    if (!isWithinCohort(position, cutoff)) return { kind: "not_yet", position, cutoff };
    return { kind: "granted", rowId: row.id, position, cutoff, referralCode: row.referral_code };
  } catch (err) {
    console.warn(
      `[playground-gate] lookup failed for ${auth.userId}:`,
      err instanceof LookupError ? err.message : "unexpected",
    );
    return { kind: "unavailable" };
  }
}
