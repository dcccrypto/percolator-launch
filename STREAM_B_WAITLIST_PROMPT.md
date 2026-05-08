# Stream B — Waitlist landing + backend

## Mission

Replace the current devnet-demo homepage at `percolator.trade/` with a polished waitlist page. Capture email signups to a queryable backend. Send a confirmation email. Show a live signup counter for social proof. Move the existing devnet UI to `/playground` (gated, accessible for OSS contributors only).

Read `~/percolator-launch/PIVOT_PLAN.md` first for context.

## End-state requirements

1. **Homepage (`/`)** is a single-page waitlist landing:
   - Above-the-fold: brand wordmark + one-liner ("Permissionless perpetual futures on Solana — join the waitlist for mainnet launch") + email input + submit
   - On submit: spinner → success state ("You're in. Check your inbox.") with optional share-the-waitlist CTA
   - Mid-page: 3-bullet "why join" (audit-pending, creator fee share, transferable positions)
   - Bottom: live counter ("X people on the waitlist") + footer with link to `/pitch` for investors and contact email
   - Polished — uses existing brand tokens (purple #9945FF + cyan #22D3EE accents on dark)

2. **API endpoints**:
   - `POST /api/waitlist/signup` — body `{email, source?}`. Validates email format, dedupes (return 200 idempotent), inserts into KV with timestamp + UTM source if present, fires confirmation email via Resend, returns `{ok: true, position?: number}`. Rate-limited to 5 req/min/IP.
   - `GET /api/waitlist/count` — returns `{count: number}` (cached 5s server-side to handle homepage traffic)

3. **Email confirmation**: branded transactional email via Resend
   - From: `dark@percolator.trade` (or a no-reply variant)
   - Subject: "You're on the Percolator waitlist"
   - Body: thanks + what to expect (audit Q3, mainnet open after that) + link to `/pitch` deck + link to X (`@percolatortrade`)
   - HTML + text fallback
   - SPF/DKIM/DMARC verified on `percolator.trade` domain (Resend onboarding flow)

4. **Anti-spam**:
   - Honeypot field (hidden `<input name="website">` — if filled, drop request silently)
   - Per-IP rate limit (5/min using Vercel's edge config or upstash-ratelimit on KV)
   - Client-side basic email regex; server-side verification

5. **Existing devnet UI**:
   - Move all current homepage devnet demo components to `/playground/page.tsx`
   - Add a small banner at top of `/playground`: "Devnet preview — not the live product. Mainnet opens post-audit."
   - Optional gating: query param `?contributor=<value>` checked against env, or just leave open since it's clearly labeled

6. **Pitch route**: `/pitch` at `app/app/pitch/page.tsx` continues to work unchanged (this is the investor-facing deck — already correct)

## Stack decisions (recommended unless stream owner has reason to deviate)

- **Backend storage**: Vercel KV (Redis-backed). Simplest for an MVP waitlist. Schema: `waitlist:emails` (sorted set keyed by email, score = unix ts), `waitlist:count` (incrementing counter). Can migrate to Postgres later if we need richer querying.
- **Email**: Resend. Add SDK, register `percolator.trade` as a verified sending domain. Use a React-Email template for the confirmation.
- **Rate limit**: `@upstash/ratelimit` against the KV instance.
- **Form validation**: Zod schema on the API route.

## Step-by-step

### Setup
1. `cd ~/percolator-launch/app`
2. Add deps: `pnpm add @vercel/kv resend @upstash/ratelimit zod react-email @react-email/components`
3. Get Vercel KV instance from Vercel dashboard (Project → Storage → Create → KV). Copy the `KV_*` env vars to `.env.local` and Vercel project env (Production + Preview).
4. Get Resend API key. Add `RESEND_API_KEY` to env.
5. Verify `percolator.trade` as a Resend sending domain (DNS records: SPF, DKIM, DMARC). Wait until "verified" status.

### Build
6. Move current homepage: `app/app/page.tsx` → `app/app/playground/page.tsx`. Add the "Devnet preview" banner at top.
7. New `app/app/page.tsx` — waitlist landing. Imports brand tokens, follows the slide-1 visual language already used at `/pitch` so the brand stays consistent.
8. New `app/app/api/waitlist/signup/route.ts`:
   ```ts
   // Pseudocode skeleton
   import { kv } from "@vercel/kv";
   import { Ratelimit } from "@upstash/ratelimit";
   import { z } from "zod";
   import { Resend } from "resend";
   
   const schema = z.object({ email: z.string().email(), source: z.string().optional(), website: z.string().max(0) });
   const ratelimit = new Ratelimit({ redis: kv, limiter: Ratelimit.fixedWindow(5, "1 m") });
   
   export async function POST(req: Request) {
     const ip = req.headers.get("x-forwarded-for") ?? "anon";
     const { success } = await ratelimit.limit(ip);
     if (!success) return new Response("rate limit", { status: 429 });
     
     const body = await req.json();
     const parsed = schema.safeParse(body);
     if (!parsed.success || parsed.data.website) return new Response("ok", { status: 200 }); // honeypot or invalid → silent
     
     const { email, source } = parsed.data;
     const ts = Date.now();
     const added = await kv.zadd("waitlist:emails", { score: ts, member: email }, { nx: true });
     if (added === 1) {
       await kv.incr("waitlist:count");
       // fire email (don't await — fire-and-forget with retry queue if added later)
       const resend = new Resend(process.env.RESEND_API_KEY);
       resend.emails.send({
         from: "Percolator <waitlist@percolator.trade>",
         to: email,
         subject: "You're on the Percolator waitlist",
         react: ConfirmationEmail({ email }),
       }).catch(console.error);
     }
     const count = await kv.get<number>("waitlist:count") ?? 0;
     return Response.json({ ok: true, position: count });
   }
   ```
9. New `app/app/api/waitlist/count/route.ts` — read counter, cache via `unstable_cache` or HTTP `Cache-Control: s-maxage=5, stale-while-revalidate=30`
10. New `app/components/waitlist/EmailForm.tsx` — client component handling submit + state machine (idle / submitting / success / error)
11. New `app/components/waitlist/CountBadge.tsx` — fetches `/api/waitlist/count` and renders "X on the waitlist" with a smooth count-up animation
12. Email template: `app/emails/ConfirmationEmail.tsx` — React Email component

### Test
13. Local `pnpm dev`, submit a real email, verify:
    - 200 response with position
    - email arrives in inbox (check spam too)
    - submit again → 200 idempotent, no duplicate count
    - submit invalid email → 200 silent (we don't leak validation errors to spammers)
    - rate-limit test: 6 quick submits → 6th gets 429
14. Build check: `pnpm tsc --noEmit && pnpm lint`
15. Deploy to a preview URL via Vercel, smoke-test there, then promote to production

### Verify in production
16. Sign up with a fresh email. Confirm:
    - Vercel KV has the entry (check via Vercel dashboard or KV CLI)
    - Email arrived (delivery + not spam)
    - Counter incremented on the page

## Quality gates

- [ ] Homepage is the waitlist (not devnet) when visiting `percolator.trade/`
- [ ] `/playground` route still serves the devnet UI (with banner) for testers/contributors
- [ ] `/pitch` continues to work unchanged
- [ ] Email validation: invalid emails silently dropped (no leaked error)
- [ ] Honeypot: filled honeypot → silent drop
- [ ] Rate limit: 6th submit in a minute → 429
- [ ] Idempotent: re-submitting same email returns 200, no duplicate KV entry, no duplicate email send
- [ ] Counter visible on homepage and updates within 5s of new signup
- [ ] Confirmation email lands in inbox, not spam (SPF/DKIM/DMARC verified)
- [ ] Mobile responsive (test at 375px width)
- [ ] Lighthouse: ≥95 perf, ≥95 a11y on the homepage
- [ ] No console errors in browser dev tools

## Privacy + legal

- Footer: link to a one-paragraph Privacy line stating "We collect email + timestamp only. We use it to email you when mainnet opens. You can unsubscribe by replying to any email."
- No third-party trackers on the waitlist page (Google Analytics is OK if simple; PostHog if we want event tracking — recommend PostHog for waitlist funnel analysis)
- GDPR consideration: storing email in EU? Vercel KV is multi-region; document the data location.

## Out of scope

- Domain redirect setup (Stream A owns this)
- Marketing copy / launch content (Stream C owns this — but use placeholder copy that matches the pitch deck one-liner for now)
- Drip email campaign (later — confirmation only for now)
- Anti-bot beyond honeypot + rate-limit (hCaptcha can be added later if abuse is observed)

## Time budget

1-2 days for build + deploy + verify.
