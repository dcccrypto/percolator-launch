/**
 * Where the PERC allocation checker and holder vote live.
 *
 * `main` is built by two Vercel projects: percolator-launch (percolator.trade,
 * the waitlist) and percolator-mainnet (mainnet.percolatorlaunch.com). These
 * surfaces belong to the waitlist host ONLY, so this is an exact match on the
 * Host header: no previews, no localhost, no subdomains, no suffix/substring
 * matching, and never a forwarding header (x-forwarded-host etc. are client-
 * controllable; Vercel routes by Host, so Host is the trustworthy value).
 *
 * Edge-safe and dependency-free: imported by middleware, pages and route handlers.
 */
export const ALLOCATION_VOTE_HOST = "percolator.trade";

/** Value for X-Robots-Tag on every allocation/vote response. */
export const NOINDEX = "noindex, nofollow";

const HOST_RE = /^percolator\.trade(?::[0-9]{1,5})?$/;

export function isAllocationVoteHost(rawHost: string | null | undefined): boolean {
  if (typeof rawHost !== "string") return false;
  return HOST_RE.test(rawHost.toLowerCase());
}

// /allocation, /vote, /api/allocation, /api/vote, plus anything beneath them or
// any extension variant of the page path (e.g. /vote.rsc). Matching is done on a
// decoded, lowercased, slash-collapsed copy so encodings and case cannot dodge it.
const SURFACE_RE = /^\/(?:api\/)?(?:allocation|vote)(?:$|[/.])/;

export function isAllocationVoteSurface(pathname: string): boolean {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // malformed escape: fall back to the raw path
  }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  return SURFACE_RE.test(p);
}
