"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeTradeCpi,
  encodePermissionlessCrank,
  CrankAction,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  derivePythPushOraclePDA,
  deriveMatcherDelegate,
  isV17Account,
  parsePortfolioV17,
} from "@percolatorct/sdk";
// TODO(oracle-migration): encodePushOraclePrice/ACCOUNTS_PUSH_ORACLE_PRICE removed in beta.29.
// The DEX oracle inline push path needs to migrate to /api/oracle/advance-phase.
import {
  encodePushOraclePrice,
  ACCOUNTS_PUSH_ORACLE_PRICE,
} from "@/lib/sdk-compat";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode } from "@/lib/oraclePrice";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { getLivePriceSnapshot } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";

const INLINE_ORACLE_PUSH_REMOVED_ERROR =
  "Inline oracle price push was removed on-chain in beta.29. Migrate this flow to /api/oracle/advance-phase or another server-side oracle publisher before trading as the oracle authority.";

// ---------------------------------------------------------------------------
// v17 portfolio account layout constants
// (mirrored from v16_program.rs state module — update if the program layout changes)
// ---------------------------------------------------------------------------

// V17 portfolio account magic (first 8 bytes, little-endian): PERCV16\0
// Used as the memcmp filter for getProgramAccounts.
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

// Provenance header offsets (HEADER_LEN=16, then provenance at +0)
// market_group_id is at HEADER_LEN(16) + provenance.market_group_id(0) = 16
// portfolio_account_id is at HEADER_LEN(16) + 32 = 48
// provenanceOwner (IMMUTABLE — set at portfolio creation, never changes) is at
// HEADER_LEN(16) + 64 = 80. Used below ONLY for readPortfolioOwner (LP owner for
// matcherDelegate derivation) — that must keep reading the same offset SetMatcherConfig
// used, regardless of any later NFT-wrap on the LP's own portfolio.
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16; // offset 16 in raw account data
const PORTFOLIO_PROVENANCE_OWNER_OFF = 80;        // offset 80 in raw account data

// Mutable owner (SDK PF_OWNER_OFF) — HEADER_LEN(16) + provenance(100) = offset 116.
// MintPositionNft moves this to the escrow PDA on wrap, leaving provenanceOwner@80
// unchanged. findV17Portfolio (the TAKER's own-portfolio discovery, below) MUST
// filter on this offset, not provenanceOwner@80, or a wrapped position still
// matches and gets treated as the taker's tradeable portfolio (portfolio-discovery
// bug — a wrapped position rendered as a normal row with a Close that fails on-chain).
const PORTFOLIO_OWNER_OFF = 116;

// PortfolioMatcherConfigV16 is appended after the portfolio body.
// PORTFOLIO_ENGINE_ACCOUNT_LEN = HEADER_LEN(16) + PORTFOLIO_STATE_LEN
// PORTFOLIO_MATCHER_CONFIG_OFF = PORTFOLIO_ENGINE_ACCOUNT_LEN
// Layout: matcher_program[32] | matcher_context[32] | matcher_delegate[32] | enabled[8] = 104 bytes
// From v16_program.rs: PORTFOLIO_MATCHER_CONFIG_OFF and PORTFOLIO_MATCHER_CONFIG_LEN=104
//
// NOTE: PORTFOLIO_STATE_LEN is not stable — derive the offset from the account data length
// minus 104 bytes (the matcher config size). The program always appends this at the end.
const PORTFOLIO_MATCHER_CONFIG_LEN = 104; // sizeof(PortfolioMatcherConfigV16)

/**
 * Read PortfolioMatcherConfigV16 from a v17 portfolio account.
 * The config is at the END of the account data, PORTFOLIO_MATCHER_CONFIG_LEN bytes before the end.
 * Returns null if the account is too short or matcher is disabled (enabled != 1).
 */
function readPortfolioMatcherConfig(data: Buffer): {
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  matcherDelegate: PublicKey;
} | null {
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN) return null;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN;
  // `data` is a Uint8Array in the browser (web3.js) — it has no Buffer.readBigUInt64LE,
  // and Next's Buffer polyfill is missing the BigInt read methods. Use DataView (works
  // for both Buffer and Uint8Array). LE = true.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const enabled = dv.getBigUint64(off + 96, true);
  if (enabled !== 1n) return null;
  return {
    matcherProgram: new PublicKey(data.subarray(off, off + 32)),
    matcherContext: new PublicKey(data.subarray(off + 32, off + 64)),
    matcherDelegate: new PublicKey(data.subarray(off + 64, off + 96)),
  };
}

/**
 * Read the LP owner public key from a v17 portfolio account provenance header.
 * The owner wallet is at offset 80 in the raw account data.
 */
function readPortfolioOwner(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(PORTFOLIO_PROVENANCE_OWNER_OFF, PORTFOLIO_PROVENANCE_OWNER_OFF + 32));
}

/**
 * Find the v17 standalone portfolio account for a given (market, owner) pair.
 * Uses getProgramAccounts with memcmp filters on magic, market_group_id, and owner.
 * Returns null if no portfolio exists for this user on this market.
 *
 * Shared with useDeposit — kept co-located here to avoid a cross-hook import.
 */
async function findV17Portfolio(
  connection: Connection,
  programId: PublicKey,
  marketPk: PublicKey,
  ownerPk: PublicKey,
): Promise<PublicKey | null> {
  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: marketPk.toBase58() } },
        { memcmp: { offset: PORTFOLIO_OWNER_OFF, bytes: ownerPk.toBase58() } },
      ],
    });
    if (accounts.length === 0) return null;

    // getProgramAccounts() does not guarantee stable result ordering.
    // Use the same canonical pubkey ordering as deposit and withdraw
    // so every owner+market flow targets the same portfolio account.
    const sorted = [...accounts].sort((a, b) =>
      a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()),
    );
    // Defense-in-depth: re-verify the mutable owner actually matches after fetch —
    // memcmp filters are advisory server-side; don't trust them blindly.
    const data = Buffer.from(sorted[0].account.data);
    const portfolio = parsePortfolioV17(data);
    if (!portfolio.owner.equals(ownerPk)) return null;
    return sorted[0].pubkey;
  } catch {
    return null;
  }
}

export function useTrade(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, accounts, raw, programId: slabProgramId, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  // Guards the catch/finally setState calls below against firing after this
  // component has unmounted — trade() does several sequential on-chain
  // awaits (portfolio scans, sendTx confirmation), and OrderTicket/PositionPanel
  // can unmount (market switch, navigation) while one of those is still in
  // flight, e.g. on a slow devnet RPC round trip.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const trade = useCallback(
    async (params: { lpIdx: number; userIdx: number; size: bigint; limitPriceE6?: bigint }) => {
      if (inflightRef.current) throw new Error("Trade already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary
        // gate.
        assertKnownProgram(slabProgramId);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);

        // Read the current mark price NON-reactively, at submit time — not
        // via the useLivePrice() hook. useTrade() is called from the trade
        // form's top level, so subscribing here would force that component
        // to re-render on every price tick just to source a value that's
        // only ever used inside this callback (see BUILD-LOG Phase 0
        // finding #3 / Phase 1). getLivePriceSnapshot() is a plain,
        // non-subscribing read of the same store useLivePrice() reads from
        // — same freshness guarantee (in fact fresher: read at the instant
        // of submit, not at the instant of last render), same values, zero
        // render cost. This changes only *where* the price value is read
        // from, not the tx-building logic below.
        const { priceE6: livePriceE6 } = getLivePriceSnapshot(slabAddress);

        // Slippage protection. The on-chain handler treats limit_price_e6 == 0
        // as a "no limit" sentinel and skips the slippage check entirely
        // (percolator.rs::handle_trade_cpi). Without a real limit, the only
        // remaining defense is the anti-off-market band (~1% by default),
        // leaving the user exposed within that band to a hostile matcher or
        // an in-band MEV race. Derive a non-zero limit from the live mark
        // when the caller omits one. An explicit `limitPriceE6: 0n` from the
        // caller is preserved as an opt-in escape hatch for keeper/bot paths
        // that intentionally skip the check.
        const effectiveLimitPriceE6: bigint =
          params.limitPriceE6 !== undefined
            ? params.limitPriceE6
            : computeLimitPriceE6({ markE6: livePriceE6 ?? 0n, size: params.size });

        // Determine oracle mode using centralised detectOracleMode (oraclePrice.ts).
        // "pyth-pinned" = Pyth feed; "admin" or "hyperp" = use slab as oracle account.
        // Pass wrapperConfigV17?.oracleMode (the on-chain oracle_mode byte) so v17
        // AUTH_MARK/keeper markets (byte=3) classify as "keeper" instead of falling
        // through to "hyperp" — SlabProvider forces indexFeedId to ZERO for both
        // modes, so key-based detection alone can't tell them apart. Every other
        // call site (MarketStatsCard, useOracleFreshness, markets/page,
        // MarketBrowser) already passes this; useTrade was the one straggler.
        const oracleMode = detectOracleMode({ ...mktConfig, oracleModeByte: wrapperConfigV17?.oracleMode });
        const useAdminOracle = oracleMode !== "pyth-pinned";
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions = [];

        // For admin oracle markets where user IS the oracle authority,
        // push a fresh price before cranking (crank needs fresh oracle data).
        // PERC-8328 / GH#1966: NEVER fall back to a hardcoded price — if we can't get
        // a valid, fresh price from the backend, abort the trade entirely. Pushing a
        // fabricated oracle price (e.g. $1) would cause catastrophic mispricing.
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          throw new Error(INLINE_ORACLE_PUSH_REMOVED_ERROR);
        }

        // Pre-trade crank ix will be built after portfolio (accountA) is resolved below,
        // since v17 PermissionlessCrank needs a valid portfolio at accounts[2].
        // The crank is inserted into instructions[] before the trade ix at the end.

        // ── v17 TradeCpi account resolution ──────────────────────────────────
        // v17 TradeCpi (tag 10) requires 7 accounts:
        //   [0] signerA       signer (taker wallet)
        //   [1] market        writable (market group account = slabPk)
        //   [2] accountA      writable (taker's standalone v17 portfolio)
        //   [3] accountB      writable (LP's standalone v17 portfolio)
        //   [4] matcherProg   readonly executable (external matcher program)
        //   [5] matcherCtx    writable (matcher context account)
        //   [6] matcherDelegate readonly (PDA: deriveMatcherDelegate)
        //
        // v12 stale accounts removed: lpOwner (signer), clock, oracle, lpPda.
        // See v16_program.rs::handle_trade_cpi (line ~7338).

        // B-6: Detect v17 using the same SDK isV17Account check as useClosePosition,
        // rather than the `accounts.length === 0` heuristic which misidentifies v12
        // markets with no LP yet (empty bitmap) as v17 markets.
        const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);

        let accountA: PublicKey;
        let accountB: PublicKey;
        let matcherProg: PublicKey;
        let matcherCtx: PublicKey;
        let matcherDelegate: PublicKey;

        if (!isV17Market) {
          // ── v12 market path ────────────────────────────────────────────────
          // LP account data comes from the parsed slab bitmap.
          // accountB = deriveLpPda (the LP's portfolio PDA in v12)
          // matcherProg/matcherCtx from the parsed LP account entry
          const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
          if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

          const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);
          accountA = wallet.publicKey; // v12: taker wallet; program validates via signer check
          accountB = lpPda;
          matcherProg = lpAccount.account.matcherProgram;
          matcherCtx = lpAccount.account.matcherContext;
          const [delegatePk] = deriveMatcherDelegate(
            programId, slabPk, accountB, lpAccount.account.owner, matcherProg, matcherCtx,
          );
          matcherDelegate = delegatePk;
        } else {
          // ── v17 market path ────────────────────────────────────────────────
          // Portfolio accounts are standalone program-owned accounts (not PDAs).
          // accountB = LP's portfolio, found by scanning the LP's config storage.
          // The LP portfolio stores PortfolioMatcherConfigV16 appended at the end.
          //
          // LP portfolio discovery: scan all v17 portfolio accounts for this market
          // and find the one that has an enabled PortfolioMatcherConfigV16.
          // v17 LP portfolios are standalone keypair-addressed accounts (NOT PDAs),
          // so deriveLpPda has no relationship to the real LP account address.
          // We use getProgramAccounts filtered by magic + market_group_id, then
          // iterate to find the portfolio with an enabled matcher config.
          //
          // NOTE: We intentionally do NOT filter by owner here — the LP portfolio
          // owner is a separate wallet, not the taker. We scan all portfolios for
          // this market and select the first one with an active matcher config.
          let lpPortfolioData: Buffer | null = null;
          let lpPortfolioPk: PublicKey | null = null;
          try {
            const allPortfolios = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: slabPk.toBase58() } },
              ],
            });
            for (const { pubkey, account } of allPortfolios) {
              const data = Buffer.from(account.data);
              const cfg = readPortfolioMatcherConfig(data);
              if (cfg) {
                lpPortfolioData = data;
                lpPortfolioPk = pubkey;
                break;
              }
            }
          } catch (scanErr) {
            throw new Error(
              `Failed to scan LP portfolio accounts on-chain: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
            );
          }
          if (!lpPortfolioPk || !lpPortfolioData) {
            throw new Error(
              "No LP portfolio with an active matcher config found for this market. " +
              "The LP must call SetMatcherConfig before trading.",
            );
          }
          accountB = lpPortfolioPk;
          const matcherCfg = readPortfolioMatcherConfig(lpPortfolioData)!;
          matcherProg = matcherCfg.matcherProgram;
          matcherCtx = matcherCfg.matcherContext;

          // Read LP owner from provenance header of the LP portfolio.
          const lpOwner = readPortfolioOwner(lpPortfolioData);

          // Derive matcherDelegate — must match what SetMatcherConfig stored.
          const [delegatePk] = deriveMatcherDelegate(
            programId, slabPk, accountB, lpOwner, matcherProg, matcherCtx,
          );
          matcherDelegate = delegatePk;

          // Find taker's portfolio (accountA).
          const userPortfolioPk = await findV17Portfolio(connection, programId, slabPk, wallet.publicKey);
          if (!userPortfolioPk) {
            throw new Error(
              "No portfolio account found for your wallet on this market. " +
              "Please deposit collateral first to create a portfolio.",
            );
          }
          accountA = userPortfolioPk;
        }

        const tradeIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
            wallet.publicKey,   // [0] signerA
            slabPk,             // [1] market
            accountA,           // [2] accountA (taker portfolio)
            accountB,           // [3] accountB (LP portfolio)
            matcherProg,        // [4] matcherProg
            matcherCtx,         // [5] matcherCtx
            matcherDelegate,    // [6] matcherDelegate
          ]),
          // v17: TradeCpi wire changed — assetIndex (u16) replaces lpIdx; sizeQ+feeBps+limitPrice.
          // feeBps=0n → program applies the market's configured tradingFeeBps.
          data: encodeTradeCpi({ assetIndex: 0, sizeQ: params.size.toString(), feeBps: 0n, limitPrice: effectiveLimitPriceE6.toString() }),
        });
        // v17 PermissionlessCrank (tag 5): [owner(s,w), market(w), portfolio(w)] + oracle tail.
        // Build after accountA is resolved — portfolio = accountA (taker's portfolio).
        // Only prepend PermissionlessCrank(FeeSweep) when the taker already has active legs.
        // Cranking an empty portfolio returns EngineNonProgress (0x16) and aborts the tx.
        // Bug fix: do NOT unconditionally prepend the crank instruction.
        let hasActiveLegs = false;
        if (isV17Market) {
          try {
            const portInfo = await connection.getAccountInfo(accountA, "confirmed");
            if (portInfo) {
              const pf = parsePortfolioV17(new Uint8Array(portInfo.data));
              hasActiveLegs = pf.legs.some((l) => l.active);
            }
          } catch {
            // If portfolio read fails, skip the crank rather than aborting the trade
            hasActiveLegs = false;
          }
        } else {
          // v12: always include the crank (v12 crank is on the slab, not the portfolio)
          hasActiveLegs = true;
        }

        if (hasActiveLegs) {
          const crankPortfolio = isV17Market ? accountA : slabPk;
          const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
            wallet.publicKey, slabPk, crankPortfolio,
          ]);
          // For Pyth mode, append oracle feed account as tail
          if (!useAdminOracle) {
            crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
          }
          const crankIx = buildIx({
            programId,
            keys: crankKeys,
            data: encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
          });
          instructions.unshift(crankIx);
        }
        instructions.push(tradeIx);

        const sig = await sendTx({ connection, wallet, instructions, computeUnits: 600_000 });
        // Re-fetch the slab so useUserAccount re-scans: a trade opens/closes a
        // leg AND changes capital, and the order-ticket balance reads
        // userAccount.account.capital. sendTx already waited for confirmation,
        // so the settled state is on-chain — but the /api/rpc account-data cache
        // (~1-1.5s) means a single immediate refresh reads the pre-trade cached
        // balance. Fire a short burst so one lands just past the cache window;
        // the balance/position reflect the trade within ~1-2s instead of waiting
        // on the (30s when WS-active) background poll. Fixes "balance doesn't
        // update after I trade". Mirrors useDeposit/useWithdraw.
        refreshSlab();
        [1200, 2200, 3500].forEach((ms) => setTimeout(() => refreshSlab(), ms));
        return sig;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) setError(msg);
        throw e;
      } finally {
        inflightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, raw, slabAddress, slabProgramId, refreshSlab]
  );

  return { trade, loading, error };
}
