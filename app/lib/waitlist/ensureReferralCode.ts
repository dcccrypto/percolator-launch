import type { SupabaseClient } from "@supabase/supabase-js";
import { generateReferralCode } from "@/lib/waitlist/referralCode";

/**
 * A member's waitlist row has a referral code: every signup gets one at insert,
 * and whoami / the playground gate only count a row that has one. A row without
 * one is a legacy row the schema backfill missed, and its owner could never get
 * back in — an email re-join is a silent duplicate that assigns nothing.
 *
 * Fill the code in. Only a null is ever written, so a concurrent assignment wins
 * and is re-read; a code collision retries with a fresh code. Returns the row's
 * code, and throws if it can be neither written nor read.
 *
 * Only call this once the caller has proved the identifier (Privy DID, wallet or
 * verified email) that matched the row — otherwise it hands out codes for rows
 * the caller does not own.
 */
export async function ensureReferralCode(supabase: SupabaseClient, rowId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { error } = await supabase
      .from("waitlist")
      .update({ referral_code: generateReferralCode() })
      .eq("id", rowId)
      .is("referral_code", null);
    if (error && error.code !== "23505") throw new Error("referral code assign failed");
    const { data, error: readError } = await supabase
      .from("waitlist")
      .select("referral_code")
      .eq("id", rowId)
      .maybeSingle();
    if (readError) throw new Error("referral code re-read failed");
    const code = (data as { referral_code?: string | null } | null)?.referral_code;
    if (code) return code;
  }
  throw new Error("referral code assign retries exhausted");
}
