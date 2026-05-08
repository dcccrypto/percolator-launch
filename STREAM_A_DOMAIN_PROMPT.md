# Stream A — Domain consolidation + redirect

## Mission

Make `percolator.trade` the canonical domain for the Percolator marketing/landing/pitch site. Make `percolatorlaunch.com` 301-redirect every path to the same path on `percolator.trade`.

Read `~/percolator-launch/PIVOT_PLAN.md` first for context.

## Pre-conditions (verify before changing anything)

1. Confirm Vercel project ownership: `~/percolator-launch` is the Next.js app currently deployed at both `percolator.trade` and (probably) `percolatorlaunch.com`.
2. Confirm DNS provider for both domains. Likely: Vercel-managed for `percolator.trade`, external (Namecheap/Cloudflare/etc.) for `percolatorlaunch.com`.
3. `vercel domains ls` should show both attached to the project. If not, you need to attach them first.

## Deliverables

1. `percolator.trade` is set as the **production primary domain** on the Vercel project (not just attached). This affects canonical URLs, Open Graph, and sitemap.
2. `percolatorlaunch.com` is configured as a **redirect domain** on Vercel, redirecting `/*` to `https://percolator.trade/*` with HTTP 301.
3. Verification — these all return 301 + correct Location header:
   - `curl -I https://percolatorlaunch.com/`
   - `curl -I https://percolatorlaunch.com/pitch`
   - `curl -I https://www.percolatorlaunch.com/`
   - `curl -I https://percolatorlaunch.com/?utm_source=test` (query string preserved)
4. SSL: both domains have valid certs (Vercel auto-provisions via Let's Encrypt).
5. SEO: at the project root, ensure `next.config.ts` (or equivalent) does not contradict the redirect. Submit a `robots.txt` directive on `percolator.trade` if anything was previously hosted on `percolatorlaunch.com` that should not be re-indexed under the new domain.

## Step-by-step

```bash
# From ~/percolator-launch:

# 1. Inspect current state
vercel domains ls

# 2. Add percolatorlaunch.com if not already attached
# (use Vercel dashboard if CLI doesn't expose redirect-only mode)
# In dashboard: Project → Settings → Domains → Add → percolatorlaunch.com
# Configure as redirect to https://percolator.trade with status code 301

# 3. Add www variants if relevant
# vercel domains add www.percolatorlaunch.com (redirect)
# vercel domains add www.percolator.trade   (redirect to apex)

# 4. Verify DNS — A records (Vercel) or CNAME pointing to cname.vercel-dns.com
dig +short percolator.trade
dig +short percolatorlaunch.com

# 5. Wait for SSL cert provisioning (Vercel does this automatically; takes 1-5 min)

# 6. Functional test
curl -sI -L https://percolatorlaunch.com/ | grep -E "^(HTTP|Location)"
curl -sI -L https://percolatorlaunch.com/pitch | grep -E "^(HTTP|Location)"
curl -sI https://percolatorlaunch.com/?utm_source=ping | head -3
```

## If we own DNS but Vercel can't redirect cleanly

Fallback: instead of Vercel redirect domain, configure the redirect at the DNS provider level via a URL forward record (most providers support this). Less elegant — Vercel-native is preferred.

## Update external references (after redirect verified)

- [ ] Pinned X tweet (replace any `percolatorlaunch.com` link with `percolator.trade`)
- [ ] X bio link
- [ ] GitHub README of `dcccrypto` repos that reference launchurl
- [ ] Pitch deck markdown at `~/percolator-ops/content/pitch-deck-copy.md` (already shows percolator.trade — no change needed)
- [ ] Discord server description / rules channel
- [ ] Email signature in `dark@percolator.trade` if used

## Out of scope

- Building the waitlist itself (Stream B owns this)
- Content / launch sequence (Stream C owns this)

## Quality gates

- [ ] HTTP 301 confirmed for `percolatorlaunch.com/*` → `percolator.trade/*` (path-preserving)
- [ ] SSL valid for both domains (cert chain checks out)
- [ ] No infinite redirect loop (`curl -L` follows to `200 OK` on `percolator.trade`)
- [ ] Search Console: submit re-index notification on the new domain after the redirect lands

## Time budget

2-4 hours including DNS propagation wait.
