# Devnet v2.2 app support (flag `NEXT_PUBLIC_DEVNET_V22`)

Status: BUILT, NOT DEPLOYED. Default OFF: with the flag unset the app behaves exactly as it does against the v2.1 programs
(no v2.2 account is decoded, no v2.2 instruction is built, no v2.2 surface renders). Set it only on the deployment that points at
the v2.2 programs, together with `NEXT_PUBLIC_DEVNET_V21=1`.

## SDK pin

`@percolatorct/sdk` 9.0.0-candidate is not published. The app pins the candidate the way the v2.1 stack did (verbatim local
ports + one adapter), see `app/lib/v22/sdk/index.ts`:

- percolator-sdk draft PR #406, branch `feat/v22-sdk`, commit `9f828ba` (vendored files as of `d98488b`), against the re-cut release candidate (wrapper
  `release/v22-wrapper-rem` c6ee0b6e, engine bfa3d037; layout JSON and per-tag CU in
  `~/percolator-ops/artifacts/v22-combination-2026-10-08/`). Files unchanged since an earlier pin keep that commit in their header (records/*, v22-math/stake, v22,
  slab, v22-band/lot, discovery).
- Ported files: `layout.ts`, `v22-wire.ts`, `v22-state.ts`, `v22-math.ts`, `v22-stake.ts`, `v22.ts`, `slab.ts`, `errors-v22.ts`
  (the v2.2 rows of `PERCOLATOR_ERRORS`), `records/*` (the layout-aware record decoders), and, new at d98488b, `v22-lp-share.ts` + `v22-lp-share-ix.ts` (share token
  identity, tag 122 builder, Metaplex record reader) and `v22-fill-events.ts` (FILL / REDUCE / MOVE decoders and the strict log attribution rule; vendored, no app surface
  shows events yet). Only imports are retargeted (installed `@percolatorct/sdk` 8.0.0, the v2.1 txv1 port). Do not edit them here; fix upstream.
- To re-pin: copy the same files from the new SDK commit (the retargeting is the import lines only), update the commit in each header and in `index.ts`. When 9.0.0 ships:
  bump the dependency, replace `lib/v22/sdk/index.ts` with `export * from "@percolatorct/sdk"`, delete the siblings.
- The layout row is the fold of 2026-10-08 (slot 2,661 B, G9 body 2,064 B, portfolio 10,603 B, leg 217 B, `WRAPPER_MAX_PORTFOLIO_ASSETS` = 4 FINAL).

Two things the SDK candidate does not provide, derived here from the engine / wrapper structs and pinned by tests against the
SDK layout row (`lib/v22/band-rent-state.ts`): the band / rent STATE words (config `band_bps` ... `band_min_leg_notional`, asset
band anchor, `rent_max`) and the rent rate port (`growth_v19::rent_rate_e9`). They should move into the SDK.

## Surfaces

1. Layout and decoders: `lib/v22/layout.ts`, `market-offsets.ts`, `records.ts` (VERSION-keyed; unknown VERSION is a typed `UnknownLayoutError`, API routes answer 422, `UnsupportedLayoutNotice`).
2. Portfolio creation at exactly `PORTFOLIO_ACCOUNT_LEN` (10,603 B) in every flow via `createPortfolioAccountIx`.
3. Errors: wrapper 104-119/123/124 and stake 33-45 (`lib/v22/error-message.ts`, `error-copy.ts`); 104 calm wait, 117/124 re-quote, 118 retry, 121 unchanged.
4. Earn exit: `earn-exit.ts`, `earn-exit-run.ts`, `useEarnExitV22`, `EarnExitQuote` (simulate first, quoted minimum before signing; pending claims too).
5. Launch wizard: `launch-plan.ts`, `launch-wire.ts`, `V22LaunchOptions` (auto lot size, price protection / holding fee toggles, optional bond inside the single launch transaction).
6. Bonds card, 7. rescue action (Earn rail), 8. first-loss stake deposit with consent text v2 (`components/stake/FirstLossDeposit.tsx`).
9. Band markets and 10. holding fee: `band-rent-state.ts`, `BandMarketNotice`, `HoldingFeeChip`, favourable-side close disabled while lagging.
Bond / insurance-units account tails are appended centrally in `sendTx` (`market-tails.ts`).
Visual check: `/dev-preview/v22` with `NEXT_PUBLIC_DEV_PREVIEW=1 NEXT_PUBLIC_DEVNET_V22=1`.


Discovery: `lib/v22/sdk/discovery.ts` (verbatim port) behind `lib/v22/discovery.ts` (flag off = installed SDK). Lot markets stay refused in the wizard (`LOT_MARKETS_ENABLED=false`); `lib/v22/lot-coverage.ts` guards trading on lot markets until every surface is covered. Bond-launch replay: `app/scripts/v22-bond-replay/RESULTS.md`.

## 2026-10-09: consumer behaviour on the re-cut candidate (all behind the flag; flag off = playground)

- **One slot per launch on v2.2 too** (`lib/create-market-args.ts`: `LAUNCH_ASSET_SLOTS = 1`, #3357). The app only uses asset index 0, the v2.2 seed kit's markets use 1 slot, and each extra slot is 2,661 B of rent for a tradable index nobody watches;
  the 4-leg cap bounds a PORTFOLIO, not what a launch allocates. Slab 4,059 B (flag on) / 3,675 B (off); `V22_MAX_PORTFOLIO_ASSETS = 4` is the cap `buildV17InitMarketArgs` enforces client-side (error 14 on chain). Wizard, mobile route, CostEstimate and the keeper co-sign pin all go through `slabSizeFor` / `wizardSlabBytes`.
- **Tag 74 carries the collateral mint as account [6]** at every call site through `lib/v22/create-lp-vault.ts` (earn-vault-seed and both `useCreateMarket` calls through it, `mobile-market-funding-ixs` and its route, `useInsuranceLP`).
- **Tag 122 names the Earn share token in the launch**, right after tag 74 in the same transaction (single-tx, batched M4a, sequential Step 4 and mobile TX4 all share `buildEarnVaultSeedInstructions`), ticker from the market symbol, generic form when empty, signed by marketauth
  (the creator wallet, which is also the instruction's payer: the wrapper pays Metaplex from its own transient fee-payer PDA, so no privileged signer reaches a Metaplex CPI) and always before `StakeInitPool` rotates marketauth. Cost ~0.0151 SOL net (the wallet must hold 0.03 SOL at that instruction),
  shown in CostEstimate and in the SOL gate. Kill switch: `NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING=0`. The keeper co-sign shape validator knows the instruction (`shareNameViolations`).
- **Playground gate**: `lib/playground-gate.ts` exempts `GET /api/earn-share/:market[/image]` when the v2.2 flag is on (a wallet holds no `pg_access` cookie; without it the Metaplex `uri` would 401 and the token would show unnamed with no icon). Flag off the path stays gated; `playground-gate-middleware.test.ts` pins both and the exact exempt set.
- **`GET /api/earn-share/[market]` and `/image`** (`lib/v22/earn-share-*.ts`): chain state only, canonical key + wrapper-owned registry or 404, v2.2 only; the logo is fetched through an allowlist and re-encoded.
- **Share counts use the share mint's own decimals** (`DepositWithdrawPanel` `lpDecimals`); the #3276 wallet note is gated on the chain (`lpShareWalletNoteV22`, `hooks/useLpShareToken.ts`).
- **Leg cap**: `planLegGroups` never puts more than 4 trade legs in one transaction (`lib/trade-leg-groups.ts`). The app builds multi-leg orders as single-leg TradeCpi instructions on asset 0 (it never emits BatchTradeCpi, tag 67).

## Reading a flag-on suite (by-name delta)
`NEXT_PUBLIC_DEVNET_V22=1 npx vitest run` is not a usable signal on its own: ~300 v2.1-fixture tests fail by design. Use the delta:
`cd app && node scripts/flag-on-delta.mjs <base-worktree>/app` runs the suite with the flag on in both checkouts (`vitest --reporter=json`) and lists only the tests that fail here and not in the base (exit 1 if any). Choose the base that isolates your change (a worktree of the previous head, or the playground-merge-only commit). `--json-base` / `--json-head` reuse saved reports.
Flag off, the whole suite is the gate (it must match playground by name).
