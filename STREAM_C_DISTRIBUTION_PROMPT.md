# Stream C — Marketing, distribution, launch sequence

## Mission

Build the go-to-market plan for the waitlist launch. Output: a 30-day content + distribution calendar, channel-by-channel strategy, launch-day playbook, and metrics dashboard. Then execute week 1.

Read `~/percolator-launch/PIVOT_PLAN.md` first for context. Also read `~/percolator-ops/content/pitch-deck-copy.md` for the messaging primitives that have already been validated against Cap (Superteam UK).

## End-state requirements

1. **30-day content calendar** (`CONTENT_CALENDAR.md`): one row per planned post/thread/email with date, channel, hook, draft copy, asset (image/diagram/clip), and target metric (followers / signups / replies).
2. **Channel playbook** (`CHANNEL_PLAYBOOK.md`): for each channel below, an objective, a posting cadence, the voice/tone, the asset templates, and a "what we don't do here" section.
3. **Launch-day playbook** (`LAUNCH_DAY.md`): hour-by-hour script for the public launch day (X thread, Discord, partner DMs, monitoring).
4. **Metrics dashboard plan** (`METRICS.md`): what we track, how often, where (PostHog / Plausible / sheet), what triggers a pivot.
5. **Week 1 executed**: at minimum, the X launch thread is written, reviewed, and shipped; Discord cross-posts are out; first partner DMs are sent.

## Audience segments (rank by leverage)

1. **Creator/team founders** who'd launch a market on a token they're already long. Their interest pays the bill (LP fees + market-creator share). Highest LTV per signup.
2. **Solana memecoin traders** who want leverage on tokens beyond the SOL/ETH/BTC trio. Highest volume of signups. Lower LTV but high virality (if a popular memecoin community endorses, signups spike).
3. **LPs / market makers** who'd fund vault liquidity. Smaller in number but high-touch. Reach via 1-1 DMs, not mass distribution.
4. **Solana ecosystem** (Superteam, Solana Foundation, Helius, Jupiter, Drift teams, Anchor team, etc.). They don't sign up for the waitlist but they amplify if we ask politely. Critical for credibility signal.
5. **Investors** who self-select via the pitch deck link. Don't optimize for them in the waitlist funnel — they find us through the deck.

## Channel playbook (proposed — refine before executing)

### X (primary)
- **Objective**: drive waitlist signups + maintain the Toly Signal (engagement from Anatoly remains our strongest social proof)
- **Cadence**: 1 substantive post/day (M/W/F threads, T/Th singles), 3-5 engagements/day on Solana ecosystem accounts
- **Voice**: technical, dry, founder-led. No degenerate "wagmi/gm" tone. Show the math, show the code.
- **Asset templates**: chart screenshots from `/pitch`, on-chain explorer links, Kani proof output, fork-only handler list, side-by-side competitor diff
- **Don't do**: paid ads pre-mainnet. Influencer DMs. Random tagging.

### Discord (own server + cross-posts)
- **Own server**: bring it up to date if not already, channels for #waitlist, #devs, #creators, #market-makers
- **Cross-post**: Solana Foundation Discord #builders, Superteam UK, Helius, the major memecoin communities (judgement call per coin — Cope, Bonk, etc.)
- **Cadence**: weekly recap thread in own server. Cross-posts: one per server per week, no spam.

### Long-form content (own blog + dev.to + Mirror)
- **Posts to ship in week 2-4**:
   1. "Why Percolator is not a fork" — 49 handlers, 51 instructions, what we built. Counter the "you're just wrapping Toly" objection before investors raise it.
   2. "Why we built our own matcher" — passive-LP vs vAMM design, why neither orderbook nor traditional AMM
   3. "The economics of long-tail perps" — fee math, LP yield model, creator fee share calculation
   4. "Pre-audit hardening: what we do every day" — counters the "457/422 Kani proofs claim" investor question by showing the work
- **Where**: own blog under `percolator.trade/blog` (build out as a route in the launch app), syndicate to Mirror.xyz, X thread teaser per post

### Podcasts (warm-only, week 4+)
- **Targets**: Lightspeed, The Solana Podcast, Bankless, Empire (rank by Solana DeFi audience overlap)
- **Approach**: warm intros via Superteam network. No cold pitching.
- **Pitch**: founder story (won Toly bounty, building permissionless perps, audit-pending, here's the math)

### Conferences (no booth, organic only)
- **Breakpoint** (annual Solana conference) — get tickets, set up 5 partner meetings before going
- **ETH Denver** — Solana booth visits, similar approach
- **Don't sponsor anything pre-audit**. Keep capital for the audit + market-maker bootstrap.

## Launch sequence (week-by-week)

### Week 0 (this week, prep)
- [ ] Get inner-circle signups (target: 100 emails before public launch). Sources: Discord members, Squid's Solana network, Superteam UK members, anyone who's commented on prior tweets.
- [ ] Draft X launch thread (12-15 tweets). Have Khubair + Squid both review.
- [ ] Pre-write 5 Discord cross-post variants (each tuned to its server's culture)
- [ ] Pre-write 10 partner DM templates (Toly, Mert/Helius, Mango, Drift founders, Jupiter founders, etc.)
- [ ] Set up basic PostHog or Plausible analytics on percolator.trade
- [ ] Verify: pitch deck loads, waitlist works, redirects work (depends on Streams A + B done)

### Week 1 (launch)
- **Day 1 (launch day)**: see `LAUNCH_DAY.md` for hour-by-hour
- **Day 2-3**: respond to every reply, every DM. Don't auto-respond.
- **Day 4**: first ecosystem mention attempt — DM 5 partners with the launch link
- **Day 5**: weekly recap thread on X — "we hit X signups in 5 days, here's what's next"
- **Day 6-7**: low-key — engage replies, fix any broken bits

### Week 2 (proof)
- Long-form post 1 ("Why Percolator is not a fork") drops Tuesday
- X thread teasing the post Monday
- Daily "build in public" tweets — port queue progress, Kani proofs added, market count climbing
- First partner reply tracking — anyone interested in being a launch partner?

### Week 3 (depth)
- Long-form post 2 ("Why we built our own matcher")
- Squid takes over X for a day — different voice, different audience overlap
- First demo: pre-recorded 2-minute screen recording of the devnet flow at `/playground` (with the "preview" banner) — distributed via X + Discord, NOT as the main waitlist CTA
- Open the first creator-rebate slot: announce "first 10 markets at mainnet launch get 50% creator-fee rebate for 90 days" as a waitlist-only perk

### Week 4 (compounding)
- Long-form post 3 ("Long-tail perps economics")
- Weekly recap with metrics screenshot — "1,247 signups, here's where they came from"
- Outreach to first podcast (warm intro through Superteam UK)
- Begin recording founder interviews / B-roll for a launch video to ship at audit-clear

## Metrics dashboard

Track weekly. Suggested tool: PostHog (free tier handles this volume).

| Metric | Source | Target (30d) | Floor (red flag) |
|---|---|---|---|
| Waitlist signups | Vercel KV count | 1,000 | 250 |
| Confirmation click-through | Resend webhook | >50% | <30% |
| X follower growth | X analytics | +1,000 | +300 |
| Pitch deck unique viewers | PostHog page event | 500 | 150 |
| Inbound DMs (qualified) | manual log | 30 | 10 |
| Partner reply rate | sent DMs / replies | >25% | <10% |
| Source attribution top 3 | UTM param tracking | known | >50% "direct" = bad |

If any "Floor" metric trips at week 2, escalate: it means the message isn't landing. Possible pivots: change the one-liner, change the audience focus, change the channel mix.

## Hand-off prompts for further sub-agents (Stream C internals)

If breaking this stream into sub-agents:
- **C.1 — Content calendar agent**: input the pitch deck + audience segments, output the 30-day calendar with draft copy.
- **C.2 — Launch-day operations agent**: input the calendar + channel list, output a minute-by-minute launch-day script.
- **C.3 — Partner outreach agent**: input the partner list + relationship state per partner, output personalized DM drafts for each.

## Out of scope

- Building the waitlist itself (Stream B owns this)
- Domain redirect (Stream A owns this)
- Audit firm engagement (separate workstream — covered in master findings)
- Mainnet trading marketing (different launch, post-audit)

## Time budget

- Prep + week 1 launch: 5 days
- Sustained content + analysis: ongoing (~6h/week founder time)
