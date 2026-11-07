/**
 * /locked copy. The waitlist handoff (percolator.trade -> play.percolator.trade) sets its session cookie on the
 * playground's own domain, so on the v2.2 PREVIEW (its own *.vercel.app origin, separate secrets) "you'll come straight
 * back here" was false (QA-0): only the team link opens the preview. The preview says so and drops the waitlist links.
 *
 * Council 2026-11-06-go1106-ux (First-timer, Clerk): the preview then named percolator.trade without a link and gave a
 * stranger no way to ask for access. It now offers a request-access path (the team's Discord, the same invite the
 * footer and launch screen use) and links the Devnet v2 playground it points to.
 */
export interface LockedLink {
  label: string;
  href: string;
}

export interface LockedCopy {
  eyebrow: string;
  title: string;
  body: string;
  showWaitlistLinks: boolean;
  /** v2.2 preview only: where a visitor without a tester link can ask for one. */
  requestAccess: LockedLink | null;
  /** v2.2 preview only: "Waitlist sign-in ... leads to the <link>, not here." */
  playgroundNote: { before: string; link: LockedLink; after: string } | null;
}

/** The team's community invite (components/layout/Footer.tsx, components/create/LaunchSuccess.tsx). */
export const REQUEST_ACCESS_URL = "https://discord.gg/fJa4BDBxPN";
/** Where waitlist members prove their spot (percolator.trade, branch `main`, #2732). */
export const PLAYGROUND_CHECK_SPOT_URL = "https://percolator.trade/playground";

export function lockedCopy(v22Preview: boolean, cutoff: string): LockedCopy {
  if (v22Preview) {
    return {
      eyebrow: "Percolator · Devnet v2.2 preview",
      title: "This is a private test build.",
      body: "It opens with a tester link from the team. Don't have one? Ask the team for a tester link on Discord.",
      showWaitlistLinks: false,
      requestAccess: { label: "Request access on Discord", href: REQUEST_ACCESS_URL },
      playgroundNote: {
        before: "Waitlist sign-in on percolator.trade opens the ",
        link: { label: "Devnet v2 playground", href: PLAYGROUND_CHECK_SPOT_URL },
        after: ", not this build.",
      },
    };
  }
  return {
    eyebrow: "Percolator · Devnet v2",
    title: `Devnet v2 is open to the first ${cutoff} on the waitlist.`,
    body: "Sign in on percolator.trade with the wallet or email you joined with. If you're in, you'll come straight back here.",
    showWaitlistLinks: true,
    requestAccess: null,
    playgroundNote: null,
  };
}
