# Pivot to waitlist — master plan

**Status**: planning, not yet executing
**Owner**: Khubair (PM/lead) + Claude (lead agent)
**Started**: 2026-05-08

## The decision

Replace the public devnet demo at `percolator.trade` with a **waitlist landing page**. Move `percolatorlaunch.com` to a 301 redirect to `percolator.trade`. Do this in days, not weeks.

## Why now

1. **The current devnet demo is broken**: keeper unfunded for 30h, oracle stale, UX rough. Anyone landing on `percolator.trade` and trying to trade right now has a bad experience.
2. **Audit gates real product**: public mainnet trading is gated on the external audit (not yet engaged). We can't put real users on the lab-mode mainnet program.
3. **We need a traction signal**: pre-audit we still need to show demand exists. A waitlist with email capture + count gives us a number to show investors and gates ourselves against scope creep.
4. **Domain consolidation**: `percolator.trade` is the brand domain (matches the `@percolatortrade` X handle, `dark@percolator.trade` email). `percolatorlaunch.com` is an artifact of an earlier name.

## End state (definition of done)

- [ ] `percolator.trade` shows a polished waitlist page (email capture + counter + clear messaging about why)
- [ ] `percolator.trade/pitch` continues to work for investor pitches
- [ ] `percolatorlaunch.com` 301-redirects every path to `percolator.trade/<same-path>`
- [ ] Email captures land in a queryable backend (Postgres / Vercel KV / Supabase) with confirmation email
- [ ] Analytics in place to track signups + sources
- [ ] Anti-spam: rate limit + honeypot or hCaptcha
- [ ] X handle (`@percolatortrade`), email (`dark@percolator.trade`), and waitlist URL all consistent across deck + page + social
- [ ] First distribution post drafted (X thread + Discord) ready to fire on launch

## Parallel work streams

Three streams, can ship in parallel:

### Stream A — Domain + redirect (smallest, do first)
1. [ ] Verify Vercel ownership of `percolator.trade` (already confirmed in earlier session — auto-deploy from main works)
2. [ ] Pull DNS records for both `percolator.trade` and `percolatorlaunch.com` to current state
3. [ ] Add `percolatorlaunch.com` as a redirect domain on the same Vercel project
4. [ ] Configure 301 redirect: `percolatorlaunch.com/*` → `percolator.trade/*` (path-preserving)
5. [ ] Test: `curl -I https://percolatorlaunch.com/pitch` returns 301 → `https://percolator.trade/pitch`
6. [ ] Update any external references (X bio, GitHub README, pitch deck, etc.)
7. [ ] Submit redirect to Google Search Console for re-indexing

### Stream B — Waitlist page + backend (the build)
1. [ ] Decision: backend choice (Vercel KV vs Supabase vs Postgres) — recommend **Vercel KV + Resend for emails** (simplest; matches Vercel deployment posture)
2. [ ] Design: 3 components — hero (one-line + email field), why-waitlist explainer, count + recent activity
3. [ ] Build: `app/app/page.tsx` (landing) replaces devnet demo as homepage; the existing devnet UI moves to `/devnet` or `/playground` route, gated behind a `?contributor=` param or removed entirely
4. [ ] API: `POST /api/waitlist/signup` — email validation, dedupe check, KV insert, send confirmation email via Resend
5. [ ] API: `GET /api/waitlist/count` — returns total signups (for the visible counter)
6. [ ] Anti-spam: honeypot field + per-IP rate limit (5/min). hCaptcha if needed later
7. [ ] Confirmation email: branded template thanking signup, sets expectations on timeline ("audit in Q3, you'll hear from us when we open mainnet")
8. [ ] Privacy: minimal data collection (email + timestamp + UTM source). Privacy line in footer.
9. [ ] Deploy + verify: signup works end-to-end, email arrives, count increments

### Stream C — Business + marketing + distribution plan
1. [ ] **Positioning**: one-liner that lands without devnet demo — "Permissionless perp futures on Solana — join the waitlist for mainnet launch"
2. [ ] **Audience segmentation**: (a) Solana memecoin traders, (b) creators/teams who'd launch a market, (c) LPs / market makers, (d) Solana ecosystem actors (Superteam, Helius, Jupiter teams, etc.)
3. [ ] **Distribution channels** (rank by leverage):
   - X: existing 3.4K followers + Toly engagement signal. **Highest immediate leverage.**
   - Solana ecosystem: Superteam UK (already in), Solana Foundation Discord, Anatoly's network
   - Creator outreach: top 50 pump.fun coins with active communities (their natural fit for permissionless perps)
   - Podcasts: Lightspeed, Bankless, The Solana Podcast (long-tail SEO + credibility)
   - Conferences: Breakpoint, ETH Denver (warm intros via Superteam)
4. [ ] **Launch content** (week 1):
   - X thread announcing the waitlist with the pitch one-liner + link to deck + waitlist form
   - Toly @-mention thread (consent to ping him? — if yes, frame as continuation of his bounty work, not name-dropping)
   - Discord post in 5+ Solana servers
5. [ ] **Ongoing content** (month 1):
   - Weekly devlog tweets — pre-audit hardening progress, port queue burn-down, Kani proof count climbing
   - Long-form: "Why Percolator is not a fork — what we built" (call-out to the 49 handlers / 51 instructions past reference)
   - "Why we built our own matcher" (the passive-LP / vAMM design write-up)
6. [ ] **Metrics + accountability**:
   - Weekly waitlist signup count
   - Source attribution (UTM tags on every shared link)
   - Conversion funnel: page view → email submit → confirmation click
   - Set a 30-day target (suggest: 1,000 verified signups)

## Decisions needed (before execution)

1. **Backend choice**: Vercel KV (simple, fast, cheap) vs Supabase (richer querying, admin UI, future-proof). Recommend Vercel KV unless we'll want admin/segmentation tooling soon.
2. **What happens to the existing devnet UI?** Three options: (a) move to `/devnet` route, gated behind contributor token, (b) delete entirely, (c) keep but mark as broken/dev preview. Recommend **(a)** — we want it accessible for OSS contributors but not on the homepage.
3. **Email provider**: Resend (developer-friendly, Vercel-native) vs Postmark vs ConvertKit (creator-flavored, includes broadcast). Recommend **Resend** for transactional + ConvertKit for broadcast if we later do drips.
4. **Waitlist incentive**: do we offer anything beyond "early access"? Options: (a) early access only, (b) early access + creator-fee rebate code for first N markets, (c) early access + token allocation hint (regulatory risk, avoid). Recommend **(b)** — gives creators a tangible reason to sign up beyond email-only.
5. **Toly @-mention strategy**: do we ping him on launch? Pro: huge social proof boost. Con: we burn the favour and risk over-using the relationship. Recommend **no @-mention on initial launch; instead, post the thread, let X distribute, and let him quote-RT if he chooses (he's done it 4 times before per the toly-signal slide).**
6. **Pitch deck visibility**: keep `/pitch` as a public link or move to a private gated link? Recommend **public** — investors find it via the waitlist and we want them to.

## Hand-off prompts (for parallel agents)

These prompts are for agents that I dispatch in parallel. Each is self-contained.

- `STREAM_A_DOMAIN_PROMPT.md` — for the deployment-expert agent (Vercel domain config + redirect)
- `STREAM_B_WAITLIST_PROMPT.md` — for the frontend-builder agent (Next.js page + KV backend + email)
- `STREAM_C_DISTRIBUTION_PROMPT.md` — for the marketing/distribution agent (content calendar, channel strategy, launch sequence)

(Each prompt drafted in its own file alongside this plan.)

## Risk register

- **Risk**: Existing pitch deck visitors hit the new homepage and find no demo. **Mitigation**: clear "join waitlist" CTA + visible link to `/pitch`.
- **Risk**: Waitlist looks empty on launch (low signup count is bad signal). **Mitigation**: get the first 100 signups from existing community before public launch (Discord + DM Squid's contacts + small private list).
- **Risk**: Domain redirect breaks existing inbound links. **Mitigation**: 301 path-preserving redirect (so `percolatorlaunch.com/X` → `percolator.trade/X`).
- **Risk**: Confirmation emails go to spam. **Mitigation**: SPF/DKIM/DMARC on `percolator.trade`. Use Resend's domain verification flow.
- **Risk**: A famous account questions our permissionless claim while devnet is broken. **Mitigation**: have the "we're pre-audit, mainnet is OSS-contributor closed beta" statement ready in pinned tweet + waitlist FAQ.

## Sequencing (suggested)

- **Day 0 (today)**: This plan committed. Stream A kicks off (domain + redirect). Stream B prep (decisions on backend + email provider).
- **Day 1**: Stream A complete. Stream B build begins.
- **Day 2-3**: Stream B build + deploy. Stream C drafts content.
- **Day 4**: Soft launch — waitlist live, ping inner circle for first 100 signups, fix any bugs.
- **Day 5**: Public launch X thread fires. Discord cross-posting. Submit to Solana Foundation newsletter.
- **Day 6+**: Ongoing content cadence + metrics review weekly.

## Open questions log

(Use this to record questions that surface during execution and aren't blocking.)

- ?
