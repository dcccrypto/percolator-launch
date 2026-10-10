# Playground judge door — access for hackathon judges

Devnet v2 is locked to the first waitlist cohort (see [PLAYGROUND-ACCESS.md](./PLAYGROUND-ACCESS.md)).
Judges (Colosseum and similar) are not on the waitlist, so they get their own door: one shareable
link that issues a normal 24 h session, without touching the waitlist or the team door.

```
https://<playground host>/enter?judge=<PLAYGROUND_JUDGE_ACCESS_CODE>
        verify code (constant time) + door open (not past PLAYGROUND_JUDGE_ACCESS_UNTIL)
        Set-Cookie: pg_access=<session sub=judge:<fp>>   303 → /?signin=1
```

## Environment (Vercel project `percolator-playground`)

| var | meaning |
|---|---|
| `PLAYGROUND_JUDGE_ACCESS_CODE` | ≥ 24 chars. Unset or short = no judge door. Generate with `openssl rand -base64 24 \| tr '+/' '-_' \| tr -d '='`. |
| `PLAYGROUND_JUDGE_ACCESS_UNTIL` | optional ISO date/time (e.g. `2026-12-31T23:59:59Z`). After it, the door closes **and** every judge session stops working. Unparseable = closed (fail closed). |

## Properties

- **Reusable.** Unlike a waitlist handoff, the code is not single use — every judge can open the same link,
  and re-open it after the 24 h session lapses.
- **Separate from the team door.** Judge sessions carry `judge:<fingerprint of the judge code>`, domain-separated
  from team fingerprints. A judge session can never pass as a team session, a handoff can never carry a
  `judge:` sub, and a forged `judge:` session never falls through to the cohort check.
- **Revocable in one step.** Rotating or unsetting `PLAYGROUND_JUDGE_ACCESS_CODE`, or passing
  `PLAYGROUND_JUDGE_ACCESS_UNTIL`, revokes every judge session on the next request. Rotating the team secret
  does not affect judges and vice versa.
- The link is meant to be shared with judges, so it will end up in their browser history and in the
  submission. Treat it as semi-public: it grants devnet access only, never admin.

## What judges get after entering

Same app as the cohort: Privy sign-in (email or a Solana wallet), and a fresh devnet wallet is auto-funded
with devnet SOL + 1,000 test USDC (`/api/auto-fund`, once per wallet per 24 h). `/faucet` tops up manually.

Tests: `app/__tests__/api/playground-judge-door.test.ts`.
