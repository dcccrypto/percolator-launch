# /allocation and /vote on percolator.trade

Two direct-URL pages for the PERC allocation checker and holder vote. They are
not linked from the header, footer, navigation, homepage or waitlist, are not in
the sitemap, and send `noindex, nofollow` (page metadata and `X-Robots-Tag`).

## Current public state (fixed in code)

- **Allocations: not published.** `/allocation` says so and has no form.
  `GET /api/allocation/status` returns `{"published":false,"data":"unavailable"}`.
  `POST /api/allocation/check` validates address syntax (400 with the checker's
  messages) and otherwise returns `503 {"status":"unavailable"}`. No figure exists to return.
- **Vote: disabled.** `/vote` says voting is not open and has no controls.
  `GET /api/vote/status` returns `{"state":"UNAVAILABLE","open":false}`.
  `POST /api/vote/challenge` and `POST /api/vote/submit` always return 503 without
  reading the body. `GET /api/vote/results` and `/api/vote/log` return 409 `not_started`.
  There is no start, admin or configure endpoint.

The state lives in `app/lib/allocation-vote/state.ts` as constants. No env var,
header, cookie or request can publish allocations or open the vote; a test
asserts these files read no `process.env`, filesystem or storage.

## Host isolation

`main` is built by two Vercel projects (percolator-launch and percolator-mainnet).
Pages and APIs serve only when the `Host` header is exactly `percolator.trade`
(optional numeric port). Every other host, including mainnet.percolatorlaunch.com,
Vercel previews, localhost, subdomains and lookalikes, gets 404 from middleware,
and again from each page and handler. Forwarding headers (`x-forwarded-host` and
similar) are never consulted. The existing `www.percolator.trade` and
`percolatorlaunch.com` 301s to `percolator.trade` are unchanged.

## Ported vs deferred

Ported from the local checker: the owner-address syntax check and its messages
(`owner.ts`), and the exact BigInt rounding / largest-remainder allocation math
(`math.ts`, parameterized, no figures baked in, not wired to any route).

Deferred to a separate, approved enabling change:

- loading a validated, approved eligible-only export (the source reads local files);
- the vote service: challenge store, signature verification, append-only log,
  receipts, locking and the token-gated admin start. The source persists these on
  the local filesystem, which Vercel serverless cannot hold durably;
- browser wallet signing (untested against a real wallet in the source).

Enabling either surface needs durable storage, an approved export and its own review.
