/**
 * /locked copy. The waitlist handoff (percolator.trade -> play.percolator.trade) sets its session cookie on the
 * playground's own domain, so on the v2.2 PREVIEW (its own *.vercel.app origin, separate secrets) "you'll come straight
 * back here" was false (QA-0): only the team link opens the preview. The preview says so and drops the waitlist links.
 */
export interface LockedCopy {
  eyebrow: string;
  title: string;
  body: string;
  showWaitlistLinks: boolean;
}

export function lockedCopy(v22Preview: boolean, cutoff: string): LockedCopy {
  if (v22Preview) {
    return {
      eyebrow: "Percolator · Devnet v2.2 preview",
      title: "This is a private test build.",
      body: "It opens with the tester link from the team. Waitlist sign-in on percolator.trade leads to the Devnet v2 playground, not here.",
      showWaitlistLinks: false,
    };
  }
  return {
    eyebrow: "Percolator · Devnet v2",
    title: `Devnet v2 is open to the first ${cutoff} on the waitlist.`,
    body: "Sign in on percolator.trade with the wallet or email you joined with. If you're in, you'll come straight back here.",
    showWaitlistLinks: true,
  };
}
