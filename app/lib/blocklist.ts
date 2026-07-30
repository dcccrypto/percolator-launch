/**
 * Blocklist for known-bad / stale market slab addresses.
 *
 * SINGLE SOURCE OF TRUTH for both server-side API routes and client-side UI.
 * All hardcoded addresses live here. Runtime overrides come from the
 * NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES env var (comma-separated), which is
 * readable by both server and client code.
 *
 * GH#1539: Previously the API routes also read BLOCKED_MARKET_ADDRESSES (server-only
 * env var) while the UI only read this hardcoded set, causing a count mismatch
 * (e.g. 170 UI vs 168 API). Fix: unified env var with NEXT_PUBLIC_ prefix so both
 * sides see the same blocklist.
 */

/** Hardcoded blocked slab addresses. */
const HARDCODED_BLOCKED_SLABS: readonly string[] = [
  // Stale SOL/USD slab — on-chain slab no longer exists; shows $100 last_price
  // causing "Failed to load market" on click. Blocked via PR #1179.
  "BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP",
  // GH#837: wrong oracle_authority — price manipulation risk. Blocked via security review.
  "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT",
  // GH#1218: NL/USD slab — corrupt on-chain OI state (9e12 micro-units per side → $89.2M
  // false total OI). Migration 045 zeroed the DB but the indexer re-synced from on-chain.
  // Blocked permanently until on-chain state is corrected. PR #1219.
  "H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph",
  // GH#1357 / PR#1362: no-liquidity slabs causing /funding/ 500 errors (Sentry).
  // Previously expected in BLOCKED_MARKET_ADDRESSES env var; hardcoded here so the
  // middleware guard (pre-rewrite) blocks them even in fresh deployments without env config.
  // SEX/USD — devnet-only token, empty vault, phantom OI (migration 048). PR #1377.
  "3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD",
  // Empty-vault phantom-OI slab (migration 048). PR #1377.
  "3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ",
  // Empty-vault phantom-OI slab (no on-chain liquidity). PR #1377.
  "3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn",
  // GH#1398: Garbage test market — symbol "11111111", 333x max_leverage,
  // oracle_authority = system program (11111111...), cannot receive price updates.
  // Deployer = DEVNET_MINT_AUTHORITY_KEYPAIR (accidental test deployment).
  "CRJH9Gtk7qQDdjzDufnAZdfa7AHisfvxCmVVvzpzQN9v",
  // GH#1398 follow-up (PR #1404): Remaining 11 phantom slabs with oracle_authority =
  // system program (11111111...). These cannot receive oracle price pushes, have no
  // real liquidity, and cause /funding/[slab] → 500 errors via backend proxy.
  // Addresses queried from markets_with_stats where oracle_authority = system program.
  "J6UU4VHbYXpCAACr5o5xjUVmquagiP2NGbbMp68VUCX9",
  "8L47yqvQRLxZ6PzW3b9jawEM79CmokBvUzeLR7mvtyuU",
  "8kkED3uZznGzSidr8kYJPd3VhzSh7LVngNUx2V1qnW9L",
  "8pKtAV3z6iTKekieF9EenQ4tk1rkAVa9oYsqe7h1PGjx",
  "Eekuz2TgXRPq3rsp5brRW5hofxLdwt6KUXbLUQCKHK9G",
  "Av3zVrW5deLpLo1qZZ7yNJ5Lq5ja4Z9ixijVhV4MuRzE",
  "CrbDmfiooBUTFfGyMhJ1hpToCrBLAXXKySBwEnLHV6kj",
  "FhpPmmuh5UDAjvEjrYBPFwmj4CP4otvsYMxtTb46p1Ss",
  "7xozYEbKhEdjQn5pCAV8bUDQGugZttqZTduPeHkoqRb8",
  "3dp3e288oPjs5w92fg26cVYQMHGuUpsj8YbSFn6wrzp4",
  "8nzjXMvdkC4fRF491QkpKE6aFTLmEcpXEnbh4wQT4iUA",
  // GH#1410: phantom slab returning HTTP 200 from /api/funding despite 404 on
  // /api/open-interest and /api/insurance. Not covered by prior blocklist entries.
  // SEX/USD devnet — empty vault, no real liquidity, causes misleading zero-filled
  // funding responses. Verified 2026-03-19 UTC.
  "3bmCyPeeDwAfLbhfnRpYJHkWVqAf3Q5JaWXGfZjbmjNp",
  // GH#1413: DfLoAzny/USD slab — phantom market with vault_balance=1M (at threshold),
  // stale on-chain OI (2T micro-units ≈ 2,000,000 tokens). Not in prior blocklist so
  // /api/open-interest/8eFFEFBY returns 200 with raw phantom data. Block to return 404.
  // Also covers /api/funding/8eFFEFBY which was returning 200 with stale zero-rate data.
  "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c",
  // Old mainnet SOL-PERP slabs — resolved and closed, replaced by V12_1_EP market.
  "FLF9ghf6H4sfSexcQzDwse4gcGZKPb6qYCqo5Btat98",
  "8NY7rvQJXNTinJkAQG1GUV8NQ1hQzdtF7iWNjK9p7tQN",
  // Closed: EWMA stuck at $61 due to oracle authority misconfiguration
  "9TGSmPLTLMii4UqstL629twGeVJ9Ndr8VD3pexnvQTsV",
  // 2026-07-09: throwaway markets from live launch-flow testing. Discovered
  // on-chain (getProgramAccounts) so removing from the registry/Blob isn't enough.
  // WIF-E2E — end-to-end launch proof market.
  "5Rdxh3n4CbLEpzovbMtUJ7M3iaZkoso8jGdfVwkv2eV8",
  // Percolator-PERP — user wizard test on a PumpSwap pool (unpriceable; PumpSwap parser bugs).
  "GRAgHm9utZy6kWJj1ZpAVntbyFxCBJyZJ1nSJmiMPPpq",
  // Orphaned dead-end from the keeper-register ordering-bug repro (never registered).
  "6QSHWb4Vm1M6f1r14t1jB7Jc4en2uieQuLpKqey71Y2S",
  // 2026-07-09: retired markets. BONK — un-tradeable (price too coarse → engine clamp
  // floor → LockActive on every trade); dropped from the lineup. Old SOL (im=667/14.99x)
  // — replaced by Fs13SX1b… (im=666/clean 15x). Both blocklisted so on-chain discovery
  // (getProgramAccounts) doesn't re-surface them.
  "4txSGha4zABqt2NUbBtbkzv3vA4rfi9J6Yr95adA4fc5",
  "DxrZXhTC11gCVtv4b2nkbszScgZPqm9DFqit5X7FvsF7",
  // 2026-07-09: ANSEM — leftover PumpSwap test market, mispriced (missing SOL→USD
  // conversion). Hidden from the UI; kept in the keeper registry as the PumpSwap
  // parser-fix verification reference. Lineup is now SOL/JUP/TRUMP/PENGU only.
  "7mzqfnuAhANvDV8PiqJBG3jehyv3rPrCMr9V6j2bCHPV",
  // 2026-07-10: retired lineup, replaced by 5 born-immortal markets. Full re-seed
  // to fix the backing-bucket-freshness deadlock (engine line-776 trap) — every
  // new market seeds both backing-bucket domains to a non-lapsing expiry
  // (u64::MAX/2) via TopUpBackingBucket at creation. These 6 old slabs are
  // superseded and blocked so on-chain discovery (getProgramAccounts) doesn't
  // re-surface them.
  "Fs13SX1b33wRh3DBbh1NmkuHSz5Z89oRb2ew7aNn1jMH", // old SOL/USDC
  "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG", // old JUP/USDC
  "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83", // old TRUMP/USDC
  "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB", // old PENGU/USDC
  "dLKhJAVPgmgxJJWvbcGvfQUNBmc7wwjdQp8Jzpg4UGq", // old Percolator/USDC
  "9oBMLGXq9mLGa5DQapTL2gia9eM425dNvf4DUNoMrzz6", // old BURNIE/USDC
  // 2026-07-27: retire the entire devnet-2.0 lineup — all six rows of the
  // `markets` table. Blocklisted rather than deleted because neither DB lever
  // is durable: StatsCollector.syncMarkets() re-inserts any on-chain market
  // missing from the table every COLLECT_INTERVAL_MS (60s) via
  // insertMarketRow({status:"active"}), and the auto-close sweep flips
  // indexer_excluded back to false for anything still in the discovery map
  // with vault > $1 or numUsedAccounts > 0 (StatsCollector.ts:901). Only this
  // blocklist holds, because it is independent of on-chain state.
  // Percolator/USDC — healthy at time of writing (all engine lock flags clear,
  // a full-size close simulates clean), but its LP portfolio is draining:
  // capital fell $240.35 → $215.91 in ~12 min with $784.09 already
  // crystallized. Same trajectory as Jimothy below.
  "7FBXdrm1vQ4ktQJjMwurq4cAHkVB1gKoZ7Hx3CAQv6P4",
  // Jimothy/USDC — LP vault bankrupt: capital $0.00, pnl −$2,479. It is the
  // sole negative-PnL account, so negative_pnl_account_count=1 pins
  // bankruptcy_hlock_active=1, try_clear_bankruptcy_hlock_if_healthy() can
  // never fire, h_lock_lane returns HMax and every favorable action (closes,
  // withdrawals) reverts Custom(21). Not recoverable without settling that
  // position. Also spends ~10% of each minute in target-effective-lag.
  "gHey79gB1xGQyXne8yEHoKmGi6jrEVigLwxSXQrYkD3",
  // TROLL/USDC — healthy (LP $1000.00, all flags clear); retired with the rest
  // of the lineup, not for a fault of its own.
  "8SHhSKuY9cun15Y2Q9p9SNEV86zzSWbeP4e59xLAv99h",
  // SOL/USDC — dead. asset0.slot_last is 1,143,246 slots behind (~5.3 days),
  // oracle_epoch=0, and it has no matcher-enabled LP portfolio, so the keeper's
  // recovery cranker skips it every cycle ("no LP-vault portfolio found yet")
  // and has never cranked it once. Renders as symbol UNKNOWN.
  "BPgSUbDsxZ9bkauWgd6eQ8oLHVx6pSsvfAjPGsS2Sso8",
  // Empty slab, vault 0, no on-chain identity → placeholderIdentity() renders
  // it as UNKNOWN. Already indexer_excluded (sticks, since vault is 0).
  "BLAHwD5wZ3Wo6naHD4GTT6zpYFcyLWAviEWR4zT7C36p",
  // ANSEM/USDC (devnet-2.0 re-launch; distinct from the 2026-07-09 ANSEM at
  // 7mzqfnuA… above). Vault 0 and already indexer_excluded, so it never
  // reached the live market list — blocked to keep discovery from re-surfacing it.
  "CseeeuKKbgNU38VRukG38mTdcPJ4KWci5GmFikEtp1X5",

  // ── 2026-07-28: harness/QA markets from the devnet-2.0 verification sweep ──
  // Created by the launch + lifecycle harnesses while proving the new market
  // path end to end (leverage matrix, fee-split checks, trade/close/withdraw,
  // LP fee distribution). They are real, funded, wrapper-owned markets, so
  // /api/markets discovers them on-chain and they were showing on the live
  // playground as untitled "UNKNOWN" rows. They are test fixtures, not
  // products — hide them. Nothing depends on them; the keeper prices only what
  // is in its own registry, which these were never added to.
  "14RFDSTK6eJ3VKprgfAafU3kqgYRVCATMV7f5Ukf2pzh",
  "2Md6RJoxQG89bKh7uzhhcHqwAmgGTJN9PN7EkZt1ZTPC",
  "43zufCcajU6H8ySqjG9vDcwFCbjGPhRCSJJAEf3E6Hiw",
  "4gM5qkkmsSqnBXHXtbM4pqGZ36sheo3cYL1jpdDfsJrS",
  "54Bbsy7q5L5LhusWkKeCon7StywWa8Vezb5zw5pfBo2o",
  "BgWFGPgNasesbiihEhadYuDdHAckSTu6AMvEBBkrdfmn",
  "CZJHRKQMHNUVy2muC7iojovnTgGtyVnpjCk1QpqheUZ5",
  "D6QgPGvo5KGFzYCuzk4U9tDm6UbEpCrjWwu9SGQTfQeU",
  "DE2c59suA6NVxRMHvhEhaWJxtBQu8XSMB2CM8wxwyoT7",
  "EtgRphLa69F15krir2E1kZL6LCCuQHDS9Cher3hmYunJ",
  "EuYE6qaNic3KhaRAtB9cM5YG62Z88dTcu3YQJNkKZQ3F",
  "GHCLa7oMUZo7qTwV8YH5RrPJGHG7z9sZ3y19dAAsgE2e",
  "GzQCM1DLMDXkbX85kVB2Un12aKc62ZRN5RdKGjqnNsbX",
  "XxCeVcNDHqEuB7GDx6zMPKN5iwvskPYAJgpy51TLuy6",

  // ── 2026-07-29: full retirement of every market in the database ──
  // The last remaining visible market. Retired with the rest so devnet 2.0
  // starts from an empty board: every slab above predates the launch wizard
  // applying real LP guardrails and a sane price-move budget, and the matcher
  // has no update instruction, so their params are write-once wrong — they can
  // only be replaced, never repaired.
  //
  // These rows were also DELETED from the database. That alone does not retire
  // a market: the indexer re-registers whatever discovery finds on chain, so
  // percolator-indexer/src/blocklist.ts carries the same list and is what makes
  // the deletion stick. Keep the two in sync.
  "5kSw1fX8Ps2kBkVU4bc1qHgUQ8AKFXHkqoq2u2ztcdJs",

  // ── 2026-07-29: the two launch-verification markets ──
  // Created while proving the devnet-2.0 launch path end to end. Both are real,
  // funded, wrapper-owned markets, but both were seeded with insurance = 0: the
  // step-4 idempotency check mistook the backing-bucket collateral for the
  // insurance seed and skipped TopUpInsurance entirely (tag 9 appears in none of
  // their launch transactions). Insurance is written once at creation and is the
  // layer that absorbs losses before the LP, so these cannot be repaired into
  // the shape a real market should have — retire them and launch fresh.
  "H9ey1RBnVoBBit2o7EUCPZWJLMNtQpuA6QiqGmM95ZJ4",  // FRANK
  "4hJ9hUotH6BwUXVmgLGmXWHfg3YLjnmA8fwAtjex3wBU",  // Percolator
  // 2026-07-30 clean slate: every market still live on the current wrapper,
  // retired together so the board starts empty. These were all created before
  // registration was consolidated onto the markets row, so none of them has a
  // creator-written row — the indexer discovered each slab on chain and filled
  // in a placeholder (metadata_source='auto', symbol='UNKNOWN', no pool
  // binding), because POST /api/markets was sending oracle_mode='keeper' into a
  // column whose CHECK constraint only accepts pyth|hyperp|admin and failed on
  // every single keeper-oracle launch. Relaunch on the fixed path instead of
  // repairing rows that were never written by their creator.
  "5sDvEs2Zwn42ESkAmQm6Ycvi1XC3X8zHhhTDX1FX3hT7",  // Fauci
  "5xRkBU83ogswJnjzqMb1a2M41NczMzyajSLvrVAsAG9Z",  // ZERO
  "3bGWBK25iHH4FusT2c7JS7VjKxghtEHLWxXpLQarwRf3",  // TripleT-PERP
  "2DDBehzGAKJPzwZXZ9HbcHBEtdkoHPRPaGBDjMCqSAUv",  // unnamed
  "FaNFCmyputbCTvSGGmxe7EU1DyjagtGKf6eYPDTvmdFC",  // unnamed
  "6RobABa7gpPvN8WsoQuXgbKKinpURwGXzUS4NJiYNaPR",  // unnamed
];

/**
 * Combined blocklist: hardcoded + NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES env var.
 *
 * GH#1539: Both API routes and client-side UI use this single set, eliminating
 * the server-only BLOCKED_MARKET_ADDRESSES env var that caused count drift.
 * Migrate any existing BLOCKED_MARKET_ADDRESSES values to
 * NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES for parity.
 */
export const BLOCKED_SLAB_ADDRESSES: ReadonlySet<string> = new Set([
  ...HARDCODED_BLOCKED_SLABS,
  ...(
    (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES : undefined) ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // GH#1539 backwards compat: also read the old server-only env var so API routes
  // don't lose overrides until deployment configs are migrated.
  ...(
    (typeof process !== "undefined" ? process.env?.BLOCKED_MARKET_ADDRESSES : undefined) ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

/**
 * Returns true if the slab address should be excluded from UI rendering.
 */
export function isBlockedSlab(slabAddress: string | null | undefined): boolean {
  if (!slabAddress) return false;
  return BLOCKED_SLAB_ADDRESSES.has(slabAddress);
}

/**
 * GH#1539: Detect legacy env var drift at startup.
 *
 * If BLOCKED_MARKET_ADDRESSES (server-only) is populated but
 * NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES is not, the UI will silently miss
 * those entries (client code cannot read server-only env vars).  Warn loudly
 * so ops teams catch misconfigurations before they cause a UI/API count
 * mismatch again.
 *
 * Call this once from your app startup (e.g. instrumentation.ts) or rely
 * on the automatic check that fires during module initialisation below.
 */
export function validateBlocklist(): void {
  if (typeof process === "undefined") return; // edge / browser — skip
  const serverOnly = (process.env.BLOCKED_MARKET_ADDRESSES ?? "").trim();
  const publicVar = (process.env.NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES ?? "").trim();
  if (serverOnly && !publicVar) {
    // eslint-disable-next-line no-console
    console.warn(
      "[blocklist] WARNING: BLOCKED_MARKET_ADDRESSES is set but " +
        "NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES is not. Client-side UI will NOT " +
        "see the server-only entries, which can recreate the GH#1539 UI/API " +
        "count mismatch. Migrate the value to NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES."
    );
  }
}

// NOTE: previously this module auto-ran `validateBlocklist()` at import time.
// blocklist.ts is imported by the Edge middleware, and a top-level side effect that
// reads a server-only env var (process.env.BLOCKED_MARKET_ADDRESSES) at module
// evaluation makes Vercel's Edge-Function analyzer reject the module ("referencing
// unsupported modules"). Call validateBlocklist() explicitly from a Node-runtime
// entrypoint (e.g. instrumentation.ts) instead of running it at import.
