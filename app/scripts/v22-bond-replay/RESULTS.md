# v2.2 bond launch replay: results (2026-10-07)

Wrapper under test: `release/v22-wrapper-rem` HEAD **f199054a** (committed 7 Oct 00:44:55), devnet build at
`~/wt-v22-rel/rem/percolator-prog/target/deploy/percolator_prog.so` (mtime 00:44:21). No rebuild was needed: `git diff HEAD -- src Cargo.toml Cargo.lock`
is empty and no source file is newer than the .so (the build was taken 34 s before the commit). Proven behaviourally too: the short-portfolio control below is
refused with Custom(5) by this .so, while the older c8501d15 artifact only fails with InvalidRealloc, so f199054a's exact-length refusal is in the binary.

| binary | sha256 |
|---|---|
| wrapper f199054a (devnet) | 39e9b8ea949df4c7970a9a843eaab43b9ff8fd9b8aa5762534a8dcb0d5abd68d |
| matcher 2b08537 | 110c62697d32498d51c905cf5258bc44c8f3abda3c292d76b37b8b631f87d43a |
| stake v22 (release/v22-stake devnet) | 733dd4d22a17a24cac1645d483617803dcce6b9077de7ab2c230e3b4adc9bd4d |
| bondreplay (this crate, release) | 990feffc951359f383cb33c5dd8d243ea86aaec7c8c8d095aad90ff0c8b0f72a (built from the committed src/main.rs) |

## Commands
```
cd app
V22_BOND_DUMP=/tmp/dump-bond.json V22_LOT_DUMP=/tmp/dump-lot.json V22_LOT_FLOOR_DUMP=/tmp/dump-lotfloor.json \
  npx vitest run __tests__/hooks/useCreateMarket.v22-launch.test.ts -t dump
cd scripts/v22-bond-replay && CARGO_BUILD_JOBS=2 cargo build --release
./target/release/bondreplay <dump.json> <wrapper.so> <full|no-tail|split|short-portfolio> <matcher.so> [stake.so]
```
Dumps are the app's REAL launch (real `useCreateMarket` + keeper co-sign route, decoded from the broadcast v1 message), at checkpoint 29e2dc38e with the
app's slab size 4,027 B. Substitutions (not app changes): matcher run at the wrapper's canonical id with the app's matcher key/ctx owner/delegate PDA re-pointed;
rent lamports raised to the rent-exempt minimum; slot 5000; sigverify off; stake instructions skipped unless a stake .so is passed.

## Results
| case | dump | result |
|---|---|---|
| full, lot_exp 0, bond ($10, rent+band) | dump-bond | LANDED, 612,936 CU (1.4M limit). Tranche wrapper-owned, 144 B, VERSION 19, kind 11, dials 800/0/216000/2500, C_b=B=0. Registry bound=1. LP mint supply 1,999,999,000 (two seeds, 1,000 dead shares). Market 4,027 B v19. Profile lot_exp=0, mark 10,000,000/lot. InitMarket data 247 B. |
| full, **lot_exp 3**, bond ($10 per lot = $0.01 per token) | dump-lot | LANDED, 613,468 CU. Same tranche/registry/supply. **Profile byte +19 lot_exp=3**, mark 10,000,000 per lot. InitMarket data 248 B (the extra lot byte: trailer tail `...01 03 17 00 00 00 ...`, lot=3 then rent 23 e9 / kink 5000...). |
| no-tail control (seeds without [11],[12]), lot 0 and lot 3 | both | FAILED ix 16 NotEnoughAccountKeys |
| split control (seed + ATA between 94 and 107), lot 0 and lot 3 | both | FAILED ix 16 Custom(110) BondConfigInvalid (107 refused after a deposit) |
| **119 control**: lot form at $5 per lot (below the $10 floor), no bond | dump-lotfloor | FAILED ix 4 (InitMarket) Custom(119) LotConfigInvalid |
| short-portfolio control (10,603 -> 10,240 B at createAccount) | dump-bond | f199054a: FAILED ix 13 Custom(5); older c8501d15: FAILED InvalidRealloc |

## Not executed
- **Stake legs (stake InitPool tag 0, BindInsuranceAuthority tag 19, the last two instructions of the app bundle).** Run with the v22 stake binary loaded at the app's stake id:
  FAILED at the first stake ix with Custom(14) (program `VmpVUArR...`). Cause: the built v22 stake binary pins its own ids (`declare_id!` A6DVNubv..., trusts wrapper 5NGgnU2j..., v2.1 fresh ids), while the app is
  configured for the older world (stake VmpVUArR..., wrapper ETDLAdi...). Running the stake legs would need every PDA the app derived under the wrapper id re-derived under 5NGgnU2j...; not attempted.
- The real keeper co-signature (sigverify is off in LiteSVM), v1-transaction packing (LiteSVM took a legacy tx), the on-chain `lot` marks pushed by a keeper.
