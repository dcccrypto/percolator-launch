# CLAUDE.md

**Contributing to this repo? Read [PLAYGROUND.md](./PLAYGROUND.md) first.** It's the
full, step-by-step guide: setup, how to run the app locally, what to contribute, and
the guardrails.

@PLAYGROUND.md

## Golden rules (don't skip these)

1. **One repo, one install.** The playground is the **`playground` branch** (`main` is the
   marketing site): `git clone -b playground …` → `pnpm install` (it installs
   `@percolatorct/sdk` from npm — no sibling clone, no SDK build). Live
   playground: https://play.percolator.trade
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
7. **Never commit the TradingView library.** Its licence forbids it in public repos. It is
   fetched at build time into `app/public/charting_library/` (gitignored) by
   `app/scripts/fetch-tv-library.mjs` when `TV_LIBRARY_TOKEN` is set; without it the trade
   page uses the built-in chart. Never `git add -f` anything under that folder, never copy
   its `.d.ts` (our typings are hand-written in `app/lib/tv/types.ts`).
   `node scripts/check-tv-library-leak.mjs` (CI runs it) must pass.
