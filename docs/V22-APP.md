# Devnet v2.2 app support (flag `NEXT_PUBLIC_DEVNET_V22`)

Status: BUILT, NOT DEPLOYED. Default OFF: with the flag unset the app behaves exactly as it does against the v2.1 programs
(no v2.2 account is decoded, no v2.2 instruction is built, no v2.2 surface renders). Set it only on the deployment that points at
the v2.2 programs, together with `NEXT_PUBLIC_DEVNET_V21=1`.

## SDK pin

`@percolatorct/sdk` 9.0.0-candidate is not published. The app pins the candidate the way the v2.1 stack did (verbatim local
ports + one adapter), see `app/lib/v22/sdk/index.ts`:

- percolator-sdk draft PR #406, branch `feat/v22-sdk`, commit `ecb6215` (LAYOUT_V22 variant B default, VERSION-keyed guard,
  builders, quotes, error tables, `planEarnExitV22`, `buildLaunchBundleV22`, `buildCreatePortfolioAccountIxV22`).
- Ported files: `layout.ts`, `v22-wire.ts`, `v22-state.ts`, `v22-math.ts`, `v22-stake.ts`, `v22.ts`, `slab.ts`, `errors-v22.ts`
  (the v2.2 rows of `PERCOLATOR_ERRORS`), and `records/*` (the layout-aware record decoders). Only imports are retargeted
  (installed `@percolatorct/sdk` 8.0.0, the v2.1 txv1 port). Do not edit them here; fix upstream.
- To re-pin: copy the same files from the new SDK commit, update the commit in each header and in `index.ts`. When 9.0.0 ships:
  bump the dependency, replace `lib/v22/sdk/index.ts` with `export * from "@percolatorct/sdk"`, delete the siblings.
- The layout row is PROVISIONAL (ledger `v22-combination-2026-10-06.md`: variant B, leg 217 B, portfolio 10,603 B, slot 2,629 B).
  If the final bytes move a number, edit the SDK row and re-port `layout.ts`; no app code holds a layout number.

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
