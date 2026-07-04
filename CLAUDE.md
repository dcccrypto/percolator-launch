# CLAUDE.md

**Contributing to this repo? Read [PLAYGROUND.md](./PLAYGROUND.md) first.** It's the
full, step-by-step guide: setup, how to run the app locally, what to contribute, and
the guardrails.

@PLAYGROUND.md

## Golden rules (don't skip these)

1. **Clone `percolator-sdk` as a sibling** of this repo before `pnpm install`, or the
   install fails (`@percolatorct/sdk` is `file:../../percolator-sdk`).
2. **Frontend + devnet only.** We want frontend improvements and bug fixes. Never
   redeploy programs, switch to mainnet, run the keeper/faucet locally, `npm publish`,
   or `vercel deploy`.
3. **No secrets in tracked files.** Real values go in `app/.env.local` (gitignored).
4. **Verify before you trust:** `cd app && npx tsc --noEmit` (0 errors) + `pnpm test`,
   then click through the flow in the browser (`pnpm dev:price-ws` + `pnpm dev`) with a
   connected devnet wallet.
5. **Branch + PR.** Never commit to `main`.
6. The external indexer API is **optional** — candles / 24h stats show empty locally.
   Expected, not a bug.
