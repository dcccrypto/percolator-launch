# Percolator Launch

The web app for [Percolator](https://github.com/aeyakovenko/percolator) perpetual futures on Solana: a trading terminal, market browser and market creation flow. Percolator is the risk engine and protocol designed by Anatoly Yakovenko; the on-chain programs and the SDK live in separate repositories (see below).

- Production site: https://percolator.trade
- Playground (devnet, test funds, built from the `playground` branch): https://play.percolator.trade

## What is in this repo

```
app/        Next.js app (App Router): trading UI, API routes, on-chain reads and writes
docs/       Architecture, deployment and design notes
tests/      Integration test scripts
e2e/        Playwright tests
scripts/    Maintenance and ops scripts
supabase/   Database migrations
```

The Solana programs are not built here. The app talks to deployed programs through the published SDK, `@percolatorct/sdk`.

## Run it locally

Requires Node.js 20+ and pnpm.

```bash
git clone https://github.com/dcccrypto/percolator-launch.git
cd percolator-launch
pnpm install
cp app/.env.example app/.env.local   # then fill in what you need
cd app
pnpm dev             # Next.js on http://localhost:3000
```

The `playground` branch has a fuller contributor guide (PLAYGROUND.md) and a local price feed; this branch does not.

Tests and checks:

```bash
pnpm test:app          # vitest, app suite
pnpm test:e2e          # Playwright
cd app && npx tsc --noEmit
```

## Programs and networks

Program IDs and per-network settings are in [`app/lib/config.ts`](./app/lib/config.ts); the SDK version is pinned in `app/package.json`. Check those, not this README, for the addresses this branch uses. They can lag the `playground` branch, which tracks the current devnet deployment in `app/lib/program-ids.ts`.

The network is chosen with `NEXT_PUBLIC_DEFAULT_NETWORK` (`devnet` or `mainnet`); see `app/.env.example` for the other settings.

## Deployment

Vercel builds the app from this repo: `main` serves percolator.trade and the `playground` branch serves play.percolator.trade. Some files under `docs/` (including `DEPLOYMENT.md`) predate the current layout and may be out of date.

## Related repositories

| Repository | What it is |
|-----------|------------|
| [percolator](https://github.com/dcccrypto/percolator) | Risk engine crate (Rust) |
| [percolator-prog](https://github.com/dcccrypto/percolator-prog) | On-chain wrapper program |
| [percolator-matcher](https://github.com/dcccrypto/percolator-matcher) | Matcher program for LP pricing |
| [percolator-stake](https://github.com/dcccrypto/percolator-stake) | Insurance LP staking program |
| [percolator-sdk](https://github.com/dcccrypto/percolator-sdk) | TypeScript SDK |
| [percolator-mobile](https://github.com/dcccrypto/percolator-mobile) | Mobile app |

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).

## License

See [LICENSE](LICENSE).
