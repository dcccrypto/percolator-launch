/**
 * The market rows a deployment WITHOUT Supabase serves: on-chain discovery of the configured wrapper,
 * narrowed to the curated seeds plus registered launches, minus blocked and provably unfinished markets,
 * with the LP capital overlaid.
 *
 * Moved out of app/api/markets/route.ts so /api/stats counts the SAME rows /api/markets lists. /api/stats
 * used to count every wrapper account discovery found (abandoned and test slabs too): the v2.2 preview's
 * portfolio read "Active Markets 27" beside a /markets page of 9.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { type DiscoveredMarket, type V17MarketGroupOI, type RiskParams } from "@percolatorct/sdk";
import { discoverMarkets } from "@/lib/v22/discovery";
import { lotExpOf } from "@/lib/v22/lot";
import { lotMarketNumbers } from "@/lib/v22/lot-view";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { parseMarketOI, isWrapperAccount } from "@/lib/v22/layout";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { readRegisteredMarkets, type RegisteredMarket } from "@/lib/playground-registered-markets";
import { parseV17RiskParams, readMaxPortfolioAssets } from "@/lib/v17-engine-config";
import { leverageFromMarginBps } from "@/lib/market-params";
import { isMarketauthComplete } from "@/lib/live-market-state";
import { isProvenIncompleteMarket } from "@/lib/market-visibility";
import { getKnownMarketLpCapitals, scanEnabledMarketLpCapitals } from "@/lib/lp-portfolio";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";

/**
 * Playground: only surface the curated/seeded markets (the ones with
 * PLAYGROUND_SLAB_META) PLUS any markets registered via POST /api/markets in
 * this session (playground-created-markets.json). On-chain discovery returns
 * every v17 market ever created on the devnet program (~80 leftover test/PoC
 * slabs with no metadata or live keeper price), which clutters the trader UI.
 * Set PLAYGROUND_SHOW_ALL_MARKETS=true to show all.
 */
const PLAYGROUND_CURATED_ONLY = process.env.PLAYGROUND_SHOW_ALL_MARKETS !== "true";

/** Path to the local JSON file that persists playground-created slab addresses. */
const PLAYGROUND_REGISTRY_PATH = path.join(process.cwd(), "lib", "playground-created-markets.json");

/**
 * Process-local registry of playground-created slab addresses.
 * Initialized from PLAYGROUND_SLAB_META (curated seeds) + any slabs previously
 * written to playground-created-markets.json (user creations). Augmented on POST.
 *
 * Module-level singleton so additions survive within the same hot-reload cycle.
 */
const _playgroundAllowedSlabs: Set<string> = (() => {
  const s = new Set(Object.keys(PLAYGROUND_SLAB_META));
  try {
    const raw = fs.readFileSync(PLAYGROUND_REGISTRY_PATH, "utf-8");
    const arr: string[] = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((v) => typeof v === "string" && s.add(v));
  } catch { /* file missing or malformed — start with curated only */ }
  return s;
})();

/** Returns the live allowed-slab set (curated seeds ∪ registered creations). */
function getPlaygroundAllowedSlabs(): Set<string> {
  return _playgroundAllowedSlabs;
}

/**
 * Register a newly created slab in the playground registry.
 * Persists to playground-created-markets.json so the set survives process restarts.
 */
export function registerPlaygroundSlab(slabAddress: string): void {
  _playgroundAllowedSlabs.add(slabAddress);
  try {
    // Write only the user-created addresses (not the curated seeds, which come from
    // PLAYGROUND_SLAB_META at startup — no need to duplicate them in the JSON file).
    const userCreated = [..._playgroundAllowedSlabs].filter(
      (s) => !PLAYGROUND_SLAB_META[s],
    );
    fs.writeFileSync(PLAYGROUND_REGISTRY_PATH, JSON.stringify(userCreated, null, 2));
  } catch (e) {
    console.warn("[playground] Failed to persist registry:", e);
  }
}

/**
 * Bug fix (leverage display/cap): per-market on-chain `initialMarginBps` varies
 * (e.g. re-seeded devnet SOL=667bps → 14x, BONK/JUP/TRUMP/PENGU=1000bps → 10x),
 * but this route used to hardcode every market's max_leverage to 10. Derive the
 * true cap from the real on-chain bps (`maxLeverage = floor(10000 / imBps)`,
 * mirroring the on-chain margin check) and only fall back to 10 when the config
 * is genuinely unavailable (parse failure / short read).
 */
const FALLBACK_MAX_LEVERAGE = 10;
function computeMaxLeverage(initialMarginBps: bigint | null | undefined): number {
  if (initialMarginBps == null || initialMarginBps <= 0n) return FALLBACK_MAX_LEVERAGE;
  // Must ROUND, not floor. The launch path derives margin with
  // `ceil(10000 / leverage)`, so 3x stores 3334 bps — and floor(10000 / 3334)
  // is 2. Flooring here advertised a 3x market as 2x in the markets list and in
  // every consumer of this route. Same defect was fixed on the client in
  // lib/market-params.ts `leverageFromMarginBps`; this server route was missed
  // because it has its own copy of the calculation.
  const lev = leverageFromMarginBps(Number(initialMarginBps));
  return Number.isFinite(lev) && lev > 0 ? lev : FALLBACK_MAX_LEVERAGE;
}

/**
 * Map a DiscoveredMarket to the API response row format.
 * For v17 markets, configV17 carries all config fields.
 * For v12 slabs, config has the fields; engine/params hold stats.
 *
 * @param riskParams v17 markets only — the real per-market RiskParams parsed
 *   from the raw slab bytes (see lib/v17-engine-config.ts). configV17
 *   (WrapperConfigV17) does not itself carry initialMarginBps — that field
 *   lives in the embedded V16ConfigAccount region, which the raw-bytes parse
 *   in discoverMarketsOnChain() supplies here.
 */
function discoveredToApiRow(
  m: DiscoveredMarket,
  v17Oi?: V17MarketGroupOI,
  registered?: RegisteredMarket,
  riskParams?: RiskParams | null,
  lotExp = 0,
  maxPortfolioAssets: number | null = null,
): Record<string, unknown> {
  const slabAddress = m.slabAddress.toBase58();
  const programId = m.programId.toBase58();

  if (m.configV17) {
    const cfg = m.configV17;
    const markPriceRaw = cfg.markEwmaE6;
    // v2.2 lot markets: the mark is per LOT and OI is in lots; show per-token price and token-scaled OI
    // (lib/v22/lot-view.ts, identity when lotExp = 0).
    const lotNums = lotMarketNumbers({ markE6: markPriceRaw, oiLongQ: v17Oi?.totalLongOiQ ?? 0n, oiShortQ: v17Oi?.totalShortOiQ ?? 0n }, lotExp);
    const markPriceUsd = lotNums.priceUsd;
    const playgroundMeta = PLAYGROUND_SLAB_META[slabAddress];
    // Live engine stats parsed from the raw market-group bytes (see the extra
    // getMultipleAccountsInfo read in discoverMarketsOnChain). undefined when
    // that read failed — OI then keeps the zeroed placeholders and insurance is null (unknown).
    const oiLong = lotNums.oiLong;
    const oiShort = lotNums.oiShort;
    const totalOi = lotNums.totalOi;
    // A failed read leaves the fund unknown (null): Earn and my-markets show "—" for it, not $0.
    const insurance = v17Oi ? Number(v17Oi.insuranceBalance) : null;
    return {
      slab_address: slabAddress,
      program_id: programId,
      mint_address: cfg.collateralMint.toBase58(),
      // Metadata: curated seeds first, then the registration Blob — wizard-
      // launched markets live there (see keeper-register). Without this
      // fallback a registered market passed the visibility filter but rendered
      // symbol/name-less ("USDC/USD") on every page.
      symbol: playgroundMeta?.symbol ?? registered?.symbol ?? null,
      name: playgroundMeta?.name ?? registered?.label ?? null,
      decimals: 6,
      deployer: cfg.marketauth.toBase58(),
      oracle_authority: cfg.marketauth.toBase58(),
      // oracleMode: 0=admin, 1=hyperp, 3=AUTH_MARK (keeper)
      oracle_mode: cfg.oracleMode === 1 ? "hyperp" : cfg.oracleMode === 3 ? "keeper" : "admin",
      dex_pool_address: playgroundMeta?.dex_pool_address ?? registered?.poolAddress ?? null,
      mainnet_ca: playgroundMeta?.mainnet_ca ?? registered?.mainnetCA ?? null,
      // Real per-market cap (e.g. SOL 667bps -> 14x, others 1000bps -> 10x) — see
      // computeMaxLeverage() doc comment. NOT a hardcoded 10 for every market.
      max_leverage: computeMaxLeverage(riskParams?.initialMarginBps),
      created_at: null,
      stats_updated_at: null,
      is_zombie: false,
      // Completeness signal for the on-chain-discovery path (the Supabase path
      // gets this from loadMergedMarketRows). A market that died mid-creation
      // still has marketauth == creator wallet, not the stake-pool PDA — see
      // isMarketauthComplete / LiveMarketState.isComplete. onChainOrStaticResponse
      // filters out `is_complete === false` so unfinished markets don't render as
      // tradeable, mirroring the Supabase path's completeOnly filter.
      is_complete: isMarketauthComplete(cfg.marketauth, m.slabAddress),
      last_price: markPriceUsd,
      mark_price: markPriceUsd,
      // v2.2 lot market only (absent otherwise): tokens per lot = 10^lot_exp. last_price / OI above are already per token.
      ...(lotExp > 0 ? { lot_exp: lotExp } : {}),
      // v2.2 only (absent otherwise): the on-chain max_portfolio_assets. > 1 marks a multi-asset test market, which
      // the listing surfaces hide (the ticket trades asset 0 only); the row stays in this payload for direct links.
      ...(maxPortfolioAssets !== null ? { max_portfolio_assets: maxPortfolioAssets } : {}),
      // Curated v2.2 entry kept only so holders can close and withdraw (NEXT_PUBLIC_V22_MARKETS_JSON `withdraw_only`).
      ...(playgroundMeta?.withdraw_only ? { withdraw_only: true } : {}),
      index_price: null,
      volume_24h: 0,
      trade_count_24h: 0,
      open_interest_long: oiLong,
      open_interest_short: oiShort,
      total_open_interest: totalOi,
      total_open_interest_usd: markPriceUsd != null ? lotNums.totalOiUsd : 0,
      insurance_fund: insurance,
      insurance_balance: insurance,
      total_accounts: 0,
      funding_rate: null,
      net_lp_pos: 0,
      lp_sum_abs: 0,
      // Unknown on v17 (no cheap on-chain source for vault/capital yet) —
      // null, NOT 0. A hard 0 here trips the phantom-OI vault guard
      // (MIN_VAULT_FOR_OI) and health logic downstream; null reads as
      // "no data" and degrades gracefully.
      c_tot: null,
      volume_24h_usd: 0,
      vault_balance: null,
    };
  }

  // v12 slab — config is a real MarketConfig; params (RiskParams) carries the
  // real initialMarginBps directly (no separate raw-bytes parse needed here).
  const collateralMint = (m.config as { collateralMint?: { toBase58: () => string } })?.collateralMint;
  return {
    slab_address: slabAddress,
    program_id: programId,
    mint_address: collateralMint?.toBase58() ?? null,
    symbol: null,
    name: null,
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    dex_pool_address: null,
    mainnet_ca: null,
    max_leverage: computeMaxLeverage(m.params?.initialMarginBps),
    created_at: null,
    stats_updated_at: null,
    is_zombie: false,
    last_price: null,
    mark_price: null,
    index_price: null,
    volume_24h: 0,
    trade_count_24h: 0,
    open_interest_long: 0,
    open_interest_short: 0,
    total_accounts: 0,
    funding_rate: null,
    vault_balance: 0,
  };
}

/**
 * Server-side on-chain market discovery via SDK discoverMarkets().
 *
 * Only runs on devnet — getProgramAccounts is blocked on public mainnet RPCs.
 * Uses maxTierQueries:0 to skip v12 tier scans entirely and only run the
 * v17 memcmp filter (one RPC call per program). Fast: ~1–2s on Helius devnet.
 *
 * Returns [] on any failure; callers must degrade gracefully.
 */
export async function discoverMarketsOnChain(
  /** Registration-Blob entries keyed by slab — supplies symbol/name/pool
   *  metadata for wizard-launched markets (curated seeds come from
   *  PLAYGROUND_SLAB_META). Optional so a Blob outage never blocks discovery. */
  registeredBySlab?: Map<string, RegisteredMarket>,
): Promise<Record<string, unknown>[]> {
  const cfg = getConfig();
  if (cfg.network !== "devnet") return [];

  const connection = getServerConnection("confirmed");

  try {
    const programId = new PublicKey(cfg.programId);
    const found = await discoverMarkets(connection, programId, {
      sequential: true,
      maxTierQueries: 0, // Skip v12 tier scans — only the v17 memcmp path runs
    });
    if (found.length === 0) return [];

    const seen = new Set<string>();
    const unique = found.filter(m => {
      const key = m.slabAddress.toBase58();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Enrich v17 rows with live OI + insurance, AND real per-market RiskParams
    // (initialMarginBps -> max_leverage), all parsed from the same raw account
    // bytes (discoverMarkets returns parsed WrapperConfigV17 only, not the
    // embedded V16ConfigAccount that carries initialMarginBps — see
    // lib/v17-engine-config.ts) — one batched RPC read for all v17 slabs.
    // Degrades gracefully: on failure the rows keep zeroed stats / fall back to
    // the default max_leverage, which is exactly the pre-enrichment behavior.
    const v17Stats = new Map<string, V17MarketGroupOI>();
    const v17Lot = new Map<string, number>();
    const v17RiskParams = new Map<string, RiskParams | null>();
    const v17MaxAssets = new Map<string, number>();
    const v17Markets = unique.filter((m) => m.configV17);
    // getMultipleAccountsInfo caps at 100 accounts per call — chunk the reads.
    const CHUNK = 100;
    for (let start = 0; start < v17Markets.length; start += CHUNK) {
      const chunk = v17Markets.slice(start, start + CHUNK);
      try {
        const infos = await connection.getMultipleAccountsInfo(chunk.map((m) => m.slabAddress));
        infos.forEach((info, i) => {
          if (!info?.data) return;
          const data = new Uint8Array(info.data);
          if (!isWrapperAccount(data)) return;
          const slab = chunk[i].slabAddress.toBase58();
          v17Stats.set(slab, parseMarketOI(data));
          v17Lot.set(slab, lotExpOf(data));
          if (isDevnetV22Enabled()) {
            const maxAssets = readMaxPortfolioAssets(data);
            if (maxAssets !== null) v17MaxAssets.set(slab, maxAssets);
          }
          v17RiskParams.set(slab, parseV17RiskParams(data, chunk[i].configV17!.tradeFeeBps));
        });
      } catch {
        /* this chunk's stats/risk-params stay unset — callers fall back gracefully */
      }
    }

    return unique.map((m) => {
      const slab = m.slabAddress.toBase58();
      return discoveredToApiRow(m, v17Stats.get(slab), registeredBySlab?.get(slab), v17RiskParams.get(slab), v17Lot.get(slab) ?? 0, v17MaxAssets.get(slab) ?? null);
    });
  } catch {
    return [];
  }
}

/**
 * The discovered rows /api/markets serves when Supabase is not configured (see the module comment).
 * `filter` narrows the rows before the LP overlay (the route's ?program_id= / ?search=), so a narrowed
 * request does not pay the LP reads for rows it drops. [] when discovery finds nothing or fails.
 */
export async function loadDiscoveredMarketRows(
  opts: { filter?: (row: Record<string, unknown>) => boolean } = {},
): Promise<Record<string, unknown>[]> {
  // Read the registration Blob ONCE per request — feeds both row metadata
  // (symbol/name for wizard-launched markets) and the visibility filter
  // below. Guarded: Blob unavailable → empty map, curated-only behavior.
  const registeredBySlab = new Map<string, RegisteredMarket>();
  try {
    for (const rm of await readRegisteredMarkets()) registeredBySlab.set(rm.slabAddress, rm);
  } catch { /* curated-only */ }

  const rows = await discoverMarketsOnChain(registeredBySlab);
  if (rows.length === 0) return [];

  // Cross-instance user-created markets live in the registration Blob — the local
  // allowed-slab Set is per-serverless-instance and doesn't persist across cold
  // starts, so union the Blob in so a wizard-launched market appears from any
  // instance. (Same read as the metadata map above — one Blob fetch per request.)
  const blobSlabs = new Set<string>(registeredBySlab.keys());

  const filtered = rows
    .filter(m => !BLOCKED_SLAB_ADDRESSES.has(m.slab_address as string))
    // Playground: hide the ~80 leftover devnet test markets — show curated seeds ∪ user-created.
    .filter(m => !PLAYGROUND_CURATED_ONLY || getPlaygroundAllowedSlabs().has(m.slab_address as string) || blobSlabs.has(m.slab_address as string))
    // Hide markets that never finished the create-market wizard (marketauth
    // never rotated to the stake-pool PDA — is_complete === false). Without
    // this, a creation that died before StakeInitPool rendered as a normal
    // "Healthy" market, and trading it reverted with Custom(9). Mirrors the
    // Supabase path's completeOnly filter (loadMergedMarketRows sets
    // is_complete there); curated seeds are never hidden (proven complete out
    // of band, and is_complete only flips false on an EXPLICIT proof). Only an
    // explicit false is dropped — undefined (legacy v12 / unknown) is kept.
    .filter(m => !isProvenIncompleteMarket(m))
    .filter(m => !opts.filter || opts.filter(m));
  if (filtered.length === 0) return [];

  // GH#2334 follow-up: discoveredToApiRow() hardcodes vault_balance: null
  // for v17 markets (no cheap on-chain source there) — overlay the real
  // LP-portfolio capital for curated markets with a known address, same
  // as the Supabase-backed path.
  try {
    const candidateSlabs = filtered
      .map((m) => String(m.slab_address ?? ""))
      .filter((s) => !!s);
    if (candidateSlabs.length > 0) {
      const lpConnection = getServerConnection("confirmed");
      const knownLpCapitals = await getKnownMarketLpCapitals(lpConnection, candidateSlabs);

      // Wizard-launched markets (e.g. Percolator, BURNIE) have no
      // hardcoded lp_portfolio_address in PLAYGROUND_SLAB_META, so
      // getKnownMarketLpCapitals never covers them. One additional
      // batched getProgramAccounts scan (not per-market) covers every
      // remaining candidate by grouping enabled LP-matcher portfolios
      // by their marketGroupId (== slab address).
      const stillMissing = candidateSlabs.filter((s) => !knownLpCapitals.has(s));
      if (stillMissing.length > 0) {
        const scanned = await scanEnabledMarketLpCapitals(lpConnection, new PublicKey(getConfig().programId));
        for (const slab of stillMissing) {
          const capital = scanned.get(slab);
          if (capital != null) knownLpCapitals.set(slab, capital);
        }
      }

      if (knownLpCapitals.size > 0) {
        return filtered.map((row) => {
          const capital = knownLpCapitals.get(String(row.slab_address ?? ""));
          return capital != null ? { ...row, vault_balance: Number(capital) } : row;
        });
      }
    }
  } catch {
    // Degrade to the original null — never let the LP overlay break discovery.
  }
  return filtered;
}
