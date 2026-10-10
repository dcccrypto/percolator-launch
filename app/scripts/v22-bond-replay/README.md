# v2.2 bond launch replay against the real wrapper binary (LiteSVM)

Proves the instruction list the app builds for a bond launch (74, creates, 94, 107, Earn seeds with the bound-vault tail, 96)
lands on the REAL variant-B wrapper, and that the negative controls fail. Not part of the app build or CI.

1. Dump the app's real bond bundle: `cd app && V22_BOND_DUMP=/tmp/bond-dump.json npx vitest run __tests__/hooks/useCreateMarket.v22-launch.test.ts -t dump`
2. `cd app/scripts/v22-bond-replay && cargo build --release` (litesvm 0.1, solana 1.18; copy a Cargo.lock from percolator-prog to build offline)
3. `./target/release/bondreplay /tmp/bond-dump.json <wrapper.so> <full|no-tail|split> <matcher.so>`
   with ART=~/percolator-ops/artifacts/v22-combination-2026-10-06: wrapper-v22-rem-c8501d15-devnet-worktree-build.so, matcher-2b08537.so.

Environment substitutions (not app changes): stake-program instructions are skipped; the matcher binary is loaded at the wrapper's
pinned canonical id `DfTxJUT5...` and the app's matcher key / ctx owner / matcher_delegate PDA are re-pointed to it; rent lamports are raised to the
real rent-exempt minimum (the app test harness prices rent as 1,000,000 + space); the clock is slot 5000; signatures are not verified.
