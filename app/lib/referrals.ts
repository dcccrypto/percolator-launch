/**
 * Portfolio > Referrals: shapes shared by GET /api/playground/referrals and the tab.
 *
 * Referral codes live on the waitlist (percolator.trade, branch `main`). The playground never reads that
 * database: the gate signs the visitor's code and a tag of the Privy login it verified into the handoff
 * (lib/playground-access.ts `ref` / `uid`), and the count of people who joined with a code comes from the
 * waitlist's public count endpoint (`/api/waitlist/my-referrals?code=`), which exposes only a number.
 */

/** Where the waitlist lives. Overridable for staging; the default is the production site. */
export function waitlistOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.NEXT_PUBLIC_WAITLIST_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]+$/.test(raw) ? raw : "https://percolator.trade";
}

/** The share link the waitlist's /r/[code] page resolves. */
export function referralLink(code: string, origin = waitlistOrigin()): string {
  return `${origin}/r/${encodeURIComponent(code)}`;
}

export type ReferralsResponse =
  /** The signed-in Privy user's own code. `joined` is null when the count could not be read. */
  | { status: "ok"; code: string; link: string; joined: number | null }
  /** No Privy login on the request. */
  | { status: "signed-out" }
  /**
   * The session holds no code for this login: no session (gate off), a team or judge session, a session
   * from before the gate sent codes, or a Privy login different from the one that entered. `enterUrl` is
   * the gate's playground page: entering through it with the waitlist account fixes all of these.
   */
  | { status: "unavailable"; enterUrl: string };
