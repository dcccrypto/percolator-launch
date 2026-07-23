"use client";

import {
  FC,
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { getSeedSlab, setCachedSlab } from "@/lib/slabCache";
import {
  parseHeader,
  parseConfig,
  parseEngine,
  parseAllAccounts,
  parseParams,
  isV17Account,
  parseWrapperConfigV17,
  parseAssetOracleProfileV17,
  V17_HEADER_LEN,
  V17_WRAPPER_CONFIG_LEN,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
  type Account,
  type WrapperConfigV17,
  type AssetOracleProfileV17,
} from "@percolatorct/sdk";
import { isMockSlab, getMockSlabState } from "@/lib/mock-trade-data";
import { isMockMode } from "@/lib/mock-mode";
import { isKnownProgram } from "@/lib/programAllowlist";
import { parseV17RiskParams } from "@/lib/v17-engine-config";

export interface SlabState {
  /** The slab account address this provider is tracking */
  slabAddress: string;
  raw: Uint8Array | null;
  header: SlabHeader | null;
  config: MarketConfig | null;
  engine: EngineState | null;
  params: RiskParams | null;
  accounts: { idx: number; account: Account }[];
  loading: boolean;
  error: string | null;
  /** The on-chain program that owns this slab account */
  programId: PublicKey | null;
  /**
   * v17 only: parsed WrapperConfigV17 block (576 bytes at offset 16, post-fee-split).
   * Null for v12.x (legacy) slabs. Use this for v17-specific config fields
   * not present in the MarketConfig compatibility shim (incl. the fee split:
   * creatorShareBps / lpShareBps / insuranceShareBps).
   */
  wrapperConfigV17: WrapperConfigV17 | null;
  /**
   * v17 only: parsed AssetOracleProfileV17 for asset index 0.
   * Offset = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN = 592 + 758 = 1350
   * (post-fee-split; the constants are imported from the SDK so this tracks the
   * 576-byte config automatically).
   * (V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN = 592 is only the start of the
   * MarketGroupV16HeaderAccount region, NOT an asset profile — see the parse
   * path below for the full layout.)
   * Null for v12.x (legacy) slabs.
   * Contains insurance_authority, insurance_operator, backing_bucket_authority,
   * oracle_authority (per-asset), and asset_admin.
   */
  assetProfile: AssetOracleProfileV17 | null;
}

/** Full context value exposed to consumers — includes stable callbacks on top of SlabState. */
export interface SlabContextValue extends SlabState {
  /**
   * Force an immediate re-fetch of the slab account from the RPC.
   * Call this after any tx that mutates the slab (deposit, withdraw, open/close position)
   * so the UI reflects the confirmed on-chain state without waiting for the next poll cycle.
   */
  refresh: () => void;
}

const defaultSlabState: SlabState = {
  slabAddress: "",
  raw: null,
  header: null,
  config: null,
  engine: null,
  params: null,
  accounts: [],
  loading: true,
  error: null,
  programId: null,
  wrapperConfigV17: null,
  assetProfile: null,
};

const defaultContextValue: SlabContextValue = { ...defaultSlabState, refresh: () => {} };

const SlabContext = createContext<SlabContextValue>(defaultContextValue);

export const useSlabState = () => useContext(SlabContext);

const POLL_INTERVAL_MS = 3000;

/**
 * Byte-for-byte comparison of two Uint8Arrays. Used to detect when a poll/WS
 * update returns on-chain bytes identical to the last-processed poll, so we can
 * skip the parse + setState entirely instead of re-emitting equivalent state
 * (which would still mint a new object reference and re-render every context
 * consumer). Cheap relative to the parse work + React re-render it replaces.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Seed-before-paint: on the client the slab data effect runs as a LAYOUT effect,
// so a slab prefetched on market-row hover (see lib/slabCache) is parsed and
// committed BEFORE the browser paints — eliminating even the one-frame loading
// skeleton on navigation. useLayoutEffect is a no-op on the server, so fall back
// to useEffect there to avoid the SSR warning.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export const SlabProvider: FC<{ children: ReactNode; slabAddress: string }> = ({ children, slabAddress }) => {
  const { connection } = useConnectionCompat();
  const [state, setState] = useState<SlabState>({ ...defaultSlabState, slabAddress });
  const wsActive = useRef(false);
  const fetchRef = useRef<() => void>(() => {});

  useIsomorphicLayoutEffect(() => {
    if (!slabAddress) {
      setState((s) => ({ ...s, slabAddress, loading: false, error: "No slab address" }));
      return;
    }

    // Mock data mode — use synthetic data for design testing (opt-in only)
    if (isMockMode() && isMockSlab(slabAddress)) {
      const mock = getMockSlabState(slabAddress);
      if (mock) {
        setState({
          slabAddress,
          raw: null,
          header: mock.header,
          config: mock.config,
          engine: mock.engine,
          params: mock.params,
          accounts: mock.accounts,
          loading: false,
          error: null,
          programId: null,
          wrapperConfigV17: null,
          assetProfile: null,
        });
      }
      return;
    }

    let slabPk: PublicKey;
    try {
      slabPk = new PublicKey(slabAddress);
    } catch {
      setState((s) => ({ ...s, slabAddress, loading: false, error: "Invalid market address. Check the URL and try again." }));
      return;
    }
    let cancelled = false;

    // v17 program writes version=16 (slab_version u16@8). Updated from v=0 (v12.x).
    // EXPECTED_SLAB_VERSION matches EXPECTED_SLAB_VERSION=16 exported from the v17 SDK.
    const EXPECTED_SLAB_VERSION = 16;

    // Tracks the raw bytes (+ owner) from the last poll/WS update that actually
    // triggered a parse, scoped to this effect run (reset whenever slabAddress
    // changes). Lets parseSlab short-circuit on a no-op tick — the vast majority
    // of 3s polls return byte-identical data — instead of re-parsing and calling
    // setState with an equivalent-but-new state object that would still cascade
    // a re-render through every SlabContext consumer.
    let lastRawData: Uint8Array | null = null;
    let lastOwnerKey: string | null = null;
    // Tracks whether the last committed state update carries a non-null `error`.
    // The byte-equality short-circuit below must NOT fire while an error is
    // outstanding — otherwise a byte-identical successful poll that follows a
    // transient error (e.g. the poll()'s null-account branch below, which sets
    // `error` directly WITHOUT going through parseSlab / updating lastRawData)
    // would short-circuit before the parse+setState that clears it, leaving a
    // stale error on screen until the on-chain bytes actually change. Every
    // branch that sets `error` (including the null-account poll branch) flips
    // this true; every branch that sets `error: null` flips it back to false.
    let lastHadError = false;

    function parseSlab(data: Uint8Array, owner?: PublicKey) {
      if (cancelled) return;
      const ownerKey = owner ? owner.toBase58() : null;
      if (
        lastRawData !== null &&
        ownerKey === lastOwnerKey &&
        !lastHadError &&
        bytesEqual(lastRawData, data)
      ) {
        // Identical bytes (and owner) to the last processed update, and no
        // outstanding error to clear — nothing changed on-chain, skip the
        // parse + setState entirely.
        return;
      }
      lastRawData = data;
      lastOwnerKey = ownerKey;
      // Refuse to surface programId for slabs owned by a program we did not
      // deploy. The slab address in the URL is user-controlled, and Solana
      // lets anyone create an account owned by any BPF program — so without
      // this gate a phishing URL like /trade/<malicious_slab> would render
      // a full trade UI whose Deposit/Trade/Withdraw flows build instructions
      // against an attacker-controlled program. The downstream signing hooks
      // (useDeposit/useWithdraw/useTrade/useInitUser) consume `programId`
      // from useSlabState() and pass it straight into buildIx; keeping
      // programId null here causes those hooks to short-circuit on their
      // existing "Wallet not connected or market not loaded" guard.
      // Source of truth: getAllProgramIds() (config.programId plus every
      // entry in programsBySlabTier). New program deploys roll out via
      // config, not by editing this gate.
      if (owner && !isKnownProgram(owner)) {
        if (process.env.NODE_ENV !== "production") {
          console.error(
            `[SlabProvider] Refusing to render slab owned by unknown program: ${owner.toBase58()}`,
          );
        }
        lastHadError = true;
        // Reset to defaults rather than spreading the previous state: the seed
        // cache (getSeedSlab, below) can already have parsed and published
        // `config`/`engine`/`accounts` for this address before the owner is
        // known. Spreading `...s` left that parsed state visible to consumers
        // on an account we are actively refusing to trust. Nulling programId
        // alone is not enough — downstream UI reads config/engine too.
        setState((s) => ({
          ...defaultSlabState,
          slabAddress: s.slabAddress,
          loading: false,
          error:
            "This market is not owned by a recognized Percolator program. " +
            "If you reached this page from a link, treat it as untrusted — only trade markets listed on the official Markets page.",
          programId: null,
        }));
        return;
      }
      try {
        // ── v17 parse path ──────────────────────────────────────────────────
        // v17 market group accounts use a completely different layout:
        //   bytes   0-15:    v17 header (magic[8] + version[2] + kind[1] + pad[1] + reserved[4])
        //   bytes  16-591:   WrapperConfigV16 (576 bytes, post-fee-split)
        //   bytes 592-1349:  MarketGroupV16HeaderAccount (758 bytes) — NOT an asset profile
        //   bytes 1350+:     per-asset slots (1797 bytes each), starting with
        //                    AssetOracleProfileV16 (400 bytes) for asset index 0.
        //
        // v17 slabs use a different magic (PERCV16\0 vs PERCOLAT) — parseHeader() THROWS on v17 data.
        // parseConfig(), parseEngine(), and parseParams() are v12.x functions that read from
        // different offsets and will return garbage on v17 data.
        if (isV17Account(data)) {
          // v17: do NOT call parseHeader — v17 magic differs from v12 and parseHeader throws.
          // Build a minimal SlabHeader shim from v17 fields (admin = cfg.marketauth).
          // parseWrapperConfigV17 reads the 576-byte config block at offset V17_HEADER_LEN (16).
          const wrapperConfigV17 = parseWrapperConfigV17(data, V17_HEADER_LEN);
          const header: SlabHeader = {
            magic: 0n,
            version: 16,
            bump: 0,
            flags: 0,
            resolved: false,
            paused: false,
            admin: wrapperConfigV17.marketauth,
            nonce: 0n,
            lastThrUpdateSlot: 0n,
          };
          // AssetOracleProfileV17 for asset index 0 starts AFTER the MarketGroupV16HeaderAccount,
          // i.e. V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN = 592 + 758 = 1350 (post-fee-split) —
          // NOT at V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN (592), which is only the start of the
          // market-group header region (bug: was parsing the header as an asset profile,
          // producing garbage oracleAuthority/authorityPriceE6/authorityTimestamp). Constants
          // are imported from the SDK, so this offset tracks the 576-byte config automatically.
          const assetProfileOffset = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN; // = 592 + 758 = 1350
          const assetProfile = parseAssetOracleProfileV17(data, assetProfileOffset);

          // Build a MarketConfig shim from v17 wrapper config for backward compat.
          // Fields not present in v17 are set to safe defaults (0n / zero PublicKey).
          // Consumers that need v17-specific fields should use wrapperConfigV17 or assetProfile.
          const ZERO_PK = new PublicKey(new Uint8Array(32));
          const config: MarketConfig = {
            collateralMint: wrapperConfigV17.collateralMint,
            // v17: vault is derived from vault_authority PDA; not stored directly in config.
            // Use zero PublicKey as placeholder — callers should derive via deriveVaultAuthority().
            vaultPubkey: ZERO_PK,
            // v17: use wrapperConfigV17.oracleMode to determine indexFeedId:
            // - oracleMode=0 (admin): read from assetProfile (may have a Pyth feed).
            // - oracleMode≠0 (hyperp, auth_mark, pyth, etc.): force indexFeedId=ZERO_PK
            //   so detectOracleMode() returns "hyperp" and resolveMarketPriceE6() uses
            //   lastEffectivePriceE6 = markEwmaE6, which is the keeper-pushed live mark.
            //   The assetProfile bytes for these markets contain garbage at the oracleLegFeeds
            //   offset (v17 layout differs from the SDK's AssetOracleProfileV17 parse); using
            //   them directly causes detectOracleMode→"admin" and authorityPriceE6 to exceed
            //   MAX_PRICE_E6 → resolveMarketPriceE6 returns 0n → null price.
            indexFeedId: wrapperConfigV17.oracleMode !== 0
              ? ZERO_PK
              : (assetProfile.oracleLegFeeds[0] ?? ZERO_PK),
            maxStalenessSlots: wrapperConfigV17.maxStalenessSecs, // stored as secs in v17
            confFilterBps: wrapperConfigV17.confFilterBps,
            vaultAuthorityBump: 0,
            invert: wrapperConfigV17.invert,
            unitScale: wrapperConfigV17.unitScale,
            fundingHorizonSlots: 0n,
            fundingKBps: 0n,
            fundingInvScaleNotionalE6: 0n,
            fundingMaxPremiumBps: 0n,
            fundingMaxBpsPerSlot: 0n,
            threshFloor: 0n,
            threshRiskBps: 0n,
            threshUpdateIntervalSlots: 0n,
            threshStepBps: 0n,
            threshAlphaBps: 0n,
            threshMin: 0n,
            threshMax: 0n,
            threshMinStep: 0n,
            // v17: oracleAuthority is per-asset in AssetOracleProfileV17
            oracleAuthority: assetProfile.oracleAuthority,
            authorityPriceE6: assetProfile.oracleTargetPriceE6,
            authorityTimestamp: assetProfile.oracleTargetPublishTime,
            oraclePriceCapE2bps: 0n,
            lastEffectivePriceE6: wrapperConfigV17.markEwmaE6,
            oiCapMultiplierBps: 0n,
            maxPnlCap: 0n,
            adaptiveFundingEnabled: false,
            adaptiveScaleBps: 0,
            adaptiveMaxFundingBps: 0n,
            marketCreatedSlot: 0n,
            oiRampSlots: 0n,
            resolvedSlot: 0n,
            insuranceIsolationBps: 0,
            oraclePhase: 0,
            cumulativeVolumeE6: 0n,
            phase2DeltaSlots: 0,
            dexPool: null,
          };

          // v17 does not have the old-style engine block or accounts bitmap.
          // engine stays null. params IS available: the v17 slab embeds the
          // engine's V16ConfigAccount (real maintenance/initial margin, fees),
          // which we parse here so RiskParams consumers (liq price, max
          // leverage, required margin) use the true on-chain values instead of
          // hardcoded ?? 500n/1000n fallbacks. See lib/v17-engine-config.ts.
          const v17Params = parseV17RiskParams(data, wrapperConfigV17.tradeFeeBps);
          lastHadError = false;
          setState((s) => ({
            slabAddress,
            raw: data,
            header,
            config,
            engine: null,
            params: v17Params,
            accounts: [],
            loading: false,
            error: null,
            programId: owner ?? s.programId,
            wrapperConfigV17,
            assetProfile,
          }));
          return;
        }

        // ── v12.x legacy parse path ─────────────────────────────────────────
        const header = parseHeader(data);

        // Graceful version mismatch detection (bug #52f49b69)
        if (header.version !== EXPECTED_SLAB_VERSION) {
          lastHadError = true;
          setState((s) => ({
            ...s,
            loading: false,
            error: `This market uses slab version ${header.version} but the current program expects version ${EXPECTED_SLAB_VERSION}. ` +
              `The program was upgraded and this market needs migration. Please contact the market admin or create a new market.`,
          }));
          return;
        }

        const config = parseConfig(data);
        const engine = parseEngine(data);
        const params = parseParams(data);
        const accounts = parseAllAccounts(data);
        lastHadError = false;
        setState((s) => ({
          slabAddress, raw: data, header, config, engine, params, accounts,
          loading: false, error: null,
          programId: owner ?? s.programId,
          wrapperConfigV17: null,
          assetProfile: null,
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // Detect version/layout mismatch errors that typically occur after a program upgrade.
        // Common symptoms: unexpected data length, bad discriminator/magic, out-of-range reads.
        const isLayoutMismatch =
          msg.includes("out of range") ||
          msg.includes("offset") ||
          msg.includes("Invalid") ||
          msg.includes("discriminator") ||
          msg.includes("magic") ||
          msg.includes("unexpected length") ||
          msg.includes("buffer") ||
          (data.length > 0 && data.length < 200); // Suspiciously small for a slab

        lastHadError = true;
        if (isLayoutMismatch) {
          setState((s) => ({
            ...s,
            loading: false,
            error:
              "This market's on-chain data format has changed (likely due to a program upgrade). " +
              "Please refresh the page. If the issue persists, the market may need migration — " +
              "contact the market admin or check the Percolator Discord for updates.",
          }));
        } else {
          setState((s) => ({ ...s, loading: false, error: msg }));
        }
      }
    }

    let subId: number | undefined;
    try {
      subId = connection.onAccountChange(slabPk, (info) => {
        if (cancelled) return;
        wsActive.current = true;
        const bytes = new Uint8Array(info.data);
        setCachedSlab(slabAddress, bytes, info.owner);
        parseSlab(bytes, info.owner);
      });
    } catch { /* ws not available */ }

    let timer: ReturnType<typeof setInterval> | undefined;
    async function poll() {
      if (cancelled) return;
      try {
        const info = await connection.getAccountInfo(slabPk);
        if (info) {
          const bytes = new Uint8Array(info.data);
          setCachedSlab(slabAddress, bytes, info.owner);
          parseSlab(bytes, info.owner);
        } else {
          // Slab account doesn't exist on-chain. This bypasses parseSlab entirely
          // (no bytes to parse), so it must flip lastHadError itself — otherwise a
          // later poll that returns the SAME bytes as before this null read would
          // hit the byte-equality short-circuit in parseSlab and skip the
          // setState that would clear this error, leaving it stuck until the
          // on-chain bytes actually change.
          lastHadError = true;
          setState((s) => ({ ...s, loading: false, error: "Market not found on-chain. It may have been closed or the address is invalid." }));
        }
      } catch (e) {
        console.error("[SlabProvider] RPC poll error:", e);
        // Set error on first load so page doesn't show loading forever, but keep already-loaded
        // data on a transient background poll error (e.g. RPC 429) instead of blanking the
        // terminal. `engine` is ALWAYS null on v17 slabs (see the v17 parse path above), so
        // guarding on it was a no-op there and a single background 429 would wipe good v17
        // state with a full-screen error. `config` is the version-agnostic "loaded" signal
        // (set for both v12 and v17) — same guard as `hasNoPriceData` in trade/[slab]/page.tsx.
        setState((s) => s.config ? s : { ...s, loading: false, error: `RPC error: ${e instanceof Error ? e.message : "connection failed"}` });
      }
    }

    // Adaptive polling: 30s when WS active, 3s when not
    function schedulePoll() {
      if (cancelled) return;
      const interval = wsActive.current ? 30_000 : POLL_INTERVAL_MS;
      timer = setTimeout(() => {
        poll().then(schedulePoll);
      }, interval);
    }

    fetchRef.current = poll;
    // 0-loading: if the slab bytes were prefetched (market-row hover or the
    // markets-page batch warm), parse them synchronously NOW so the terminal
    // renders immediately instead of showing a skeleton for the getAccountInfo
    // round-trip. getSeedSlab is the stale-tolerant tier (up to ~10min old):
    // the poll below fires immediately and byte-equality-dedups the no-op
    // re-parse, so a stale seed only bounds the ONE pre-paint frame — with the
    // strict 20s getCachedSlab tier here, anyone browsing /markets for >20s
    // before clicking missed the seed and ate a ~560ms full-page skeleton.
    const cachedSeed = getSeedSlab(slabAddress);
    if (cachedSeed) parseSlab(cachedSeed.data, cachedSeed.owner);
    poll().then(schedulePoll);

    return () => {
      cancelled = true;
      wsActive.current = false;
      if (subId !== undefined) connection.removeAccountChangeListener(subId);
      if (timer) clearTimeout(timer);
    };
  }, [connection.rpcEndpoint, slabAddress]);

  // Re-poll immediately when tab becomes visible (browser sleep/wake)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") fetchRef.current();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const refresh = useCallback(() => { fetchRef.current(); }, []);

  // Memoize the context value so its identity only changes when `state` changes
  // (i.e. when on-chain data actually changed). Without this, the inline
  // `{ ...state, refresh }` literal minted a new object on every SlabProvider
  // render, forcing EVERY context consumer (TradingChart, PositionsDock,
  // OrderTicket, …) to re-render even when nothing changed — the shared floor
  // Phase 6 traced under the per-panel re-render counts.
  const ctxValue = useMemo(() => ({ ...state, refresh }), [state, refresh]);

  return (
    <SlabContext.Provider value={ctxValue}>
      {children}
    </SlabContext.Provider>
  );
};
