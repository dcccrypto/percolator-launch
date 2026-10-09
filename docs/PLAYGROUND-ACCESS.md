# Playground access — the devnet v2 waitlist lock

Devnet v2 (play.percolator.trade, branch `playground`) is open to the **first 1,000
positions on the waitlist**. The waitlist and the "am I in?" check live on percolator.trade
(branch `main`, `/playground` + `POST /api/playground/authorize`, design by @0x-SquidSol in #2732).
The two are different registrable domains, so the gate hands the visitor over with a short-lived
signed token and this app sets its own cookie.

```
percolator.trade/playground ──(Privy → waitlist row → position ≤ cutoff)──► handoff token (90s)
        │
        └──► play.percolator.trade/enter?t=<handoff>   (or POST form field `token`)
                 verify signature + expiry + position ≤ cutoff + single use
                 Set-Cookie: pg_access=<session>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
                 303 → /
             middleware.ts: every request checks pg_access (when PLAYGROUND_GATE_ENABLED=true)
                 pages without it → 307 /locked     /api/* without it → 401 {"error":"Playground access required"}
```

## Token format (shared with `main`'s lib/playground-access.ts — keep byte-compatible)

| | |
|---|---|
| token | `b64url(JSON.stringify({sub, pos, exp})) + "." + b64url(HMAC-SHA256(key, body))` |
| handoff key | `PLAYGROUND_ACCESS_SECRET + ":handoff:v1"`, TTL 90 s |
| session key | `PLAYGROUND_ACCESS_SECRET + ":session:v1"`, TTL 24 h |
| `sub` | waitlist row id (never a wallet or email), or `team:<fingerprint>` for team sessions |
| `pos` | waitlist position (same `waitlist_position` RPC the waitlist page shows) |

The two key derivations mean a handoff can never be used as a session or vice versa.
`__tests__/lib/playground-access.test.ts` mints with a verbatim copy of `main`'s code
(`__tests__/fixtures/gate-playground-access.pr2732.ts`) and verifies here in both directions —
re-copy the fixture if `main` ever changes the format, and bump both sides to `:v2` together.

## Environment (Vercel project `percolator-playground`)

| var | meaning |
|---|---|
| `PLAYGROUND_GATE_ENABLED` | `true` enforces the lock. Anything else (unset, `false`, `1`, `TRUE`) = off — the kill switch. |
| `PLAYGROUND_ACCESS_SECRET` | ≥ 32 chars, **identical** to the value on percolator.trade. Unset/short with the gate on = everyone locked out (fail closed). |
| `PLAYGROUND_COHORT_CUTOFF` | optional, default `1000`. Checked at `/enter` and on every request, so lowering it takes effect immediately. |
| `PLAYGROUND_TEAM_BYPASS_SECRET` | ≥ 32 chars, playground only. Enables the team door below. Unset = no team door. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Required for new waitlist handoffs when the gate is enabled. Missing or unavailable Redis rejects handoffs; Redis also supports rate limiting. |

## Redis outage and replay protection

When `PLAYGROUND_GATE_ENABLED=true`, new waitlist handoff
exchanges require a working shared Redis replay store.

- Redis SET NX provides cross-instance single-use protection.
- If Redis is unavailable or its configuration is missing,
  new waitlist handoffs are rejected.
- Rejected handoffs redirect to `/locked` without issuing
  a `pg_access` session cookie.
- Existing valid session cookies remain usable.
- The team bypass continues to use its separate authentication.
- When the gate is disabled, the per-instance memory fallback
  remains available for compatibility.

This is a deliberate security-versus-availability trade-off.
A Redis outage temporarily prevents new waitlist users from
entering while the gate is enforced.

Before enabling the gate, verify Redis configuration and
availability. Operators should restore Redis availability
rather than disable the access gate as a routine workaround.


## Team door

So the team is never locked out: visit `/enter?team=<PLAYGROUND_TEAM_BYPASS_SECRET>` (or POST a form
field `team`). The secret is compared in constant time server-side and issues a normal 24 h session.
Team sessions carry a fingerprint of the team secret, so **rotating or unsetting
`PLAYGROUND_TEAM_BYPASS_SECRET` revokes every team session at once**. The query string ends up in
browser history and request logs — use it from your own browser, and rotate it if it is shared.
There are no wallet or email allowlists in code.

## What stays reachable without a session

`/enter`, `/locked`, `/_next/*`, `/_vercel/*`, `/.well-known/*`, `/images/*`, `/icons/*`, `/audio/*`,
`/token-metadata/*` (on-chain metadata URIs), top-level static files, `/robots.txt`, `/sitemap.xml`,
`/opengraph-image`, `/twitter-image`, and these server-to-server API routes, each of which
authenticates itself:

| route | caller | its own auth |
|---|---|---|
| `GET /api/health` | uptime monitoring | none needed — returns only `{status,rpc,indexer,ts}` |
| `GET /api/playground/registered-markets` | oracle keeper poll (cookie-less) | public market config by design |
| `PATCH /api/markets/<slab>` | external ops/keeper signer | HMAC-SHA256 over `KEEPER_REGISTER_SECRET`, timestamp-bounded |
| `POST /api/oracle-keeper/register` | keeper registration | HMAC-SHA256 over `KEEPER_REGISTER_SECRET`, timestamp-bounded |
| `POST /api/oracle/set-price-cap` | operator tool | `x-admin-secret` vs `ADMIN_API_SECRET`, fails closed |

Every other `/api/*` route is called same-origin by the app in the browser and is gated (the cookie
rides along). There are no Vercel crons on this project. A test enumerates `app/api/**/route.ts` and
fails if the exempt set changes, so a new route is gated by default. Admin calls with
`x-admin-secret` to gated routes (e.g. `keeper-register`) need a team session cookie too.

## Rollout order

1. Set `PLAYGROUND_ACCESS_SECRET` (same value) on **both** Vercel projects, and
   `PLAYGROUND_TEAM_BYPASS_SECRET` on `percolator-playground`. Leave `PLAYGROUND_GATE_ENABLED` unset.
2. Deploy `playground` (this lock, gate off) and `main` (the gate page).
3. Team: `/enter?team=…` → confirm you land on `/` with a `pg_access` cookie.
4. A cohort member: percolator.trade/playground → sign in → lands on the app.
5. Set `PLAYGROUND_GATE_ENABLED=true` on `percolator-playground`, redeploy, check a private window is
   sent to `/locked` and `/api/markets` 401s, and that the keeper is still pricing.
6. To open up instantly: unset `PLAYGROUND_GATE_ENABLED` and redeploy.

If the playground moves to a subdomain of percolator.trade, the handoff becomes unnecessary — a
cookie on `.percolator.trade` covers both — and `/enter`'s handoff half should be deleted.
