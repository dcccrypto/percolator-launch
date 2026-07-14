"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeWithdrawCollateral,
  encodePermissionlessCrank,
  CrankAction,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
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
import { getPortfolioRawSnapshot, isLpPortfolio, makePortfolioScanKey } from "@/lib/userAccountScan";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode, sanitizePriceE6, applyInvert } from "@/lib/oraclePrice";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { humanizeError } from "@/lib/errorMessages";
import { computePositionInitialMargin, estimateEntryFromPnl } from "@/lib/trading";
import { getEntryPrice } from "@/lib/entry-price";
import { isSentinelValue } from "@/lib/health";

// M7: withdraw's own EngineStale(19) surface. Unlike a trade (which can be
// auto-retried after the next keeper crank via withTransientRetry — see
// OrderTicket/useClosePosition), withdraw here never auto-retries, and a
// deep-stale/dead market (see DEFINITIVE-PLAN-2026-07-08.md) never
// self-clears on a manual retry either — only a maintainer re-seed does.
// humanizeError's generic "stale - try again in a moment" copy is actively
// misleading for THIS instruction, so detect the code locally (mirrors
// errorMessages.ts's own extractCustomIndex regex) and override the message
// without touching the shared error-copy table other flows still rely on.
const ENGINE_STALE_CODE = 19;
function isEngineStaleWithdrawError(msg: string): boolean {
  const m = msg.match(/Custom\((\d+)\)/) ?? msg.match(/"Custom"\s*:\s*(\d+)/);
  return m !== null && parseInt(m[1], 10) === ENGINE_STALE_CODE;
}
const ENGINE_STALE_WITHDRAW_MESSAGE =
  "This market's on-chain price/crank data is too stale to process a withdrawal. This won't clear on its own retry — the market needs a fresh crank from the maintainer before withdrawals will work again.";

const INLINE_ORACLE_PUSH_REMOVED_ERROR =
  "Inline oracle price push was removed on-chain in beta.29. Migrate this flow to /api/oracle/advance-phase or another server-side oracle publisher before withdrawing as the oracle authority.";

export function useWithdraw(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, wrapperConfigV17, programId: slabProgramId, params: slabParams, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const withdraw = useCallback(
    async (params: { userIdx: number; amount: bigint; portfolioPk?: PublicKey }) => {
      if (inflightRef.current) throw new Error("Withdrawal already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary
        // gate; this hook is a second line so unknown-program slabs cannot
        // produce a wallet-signed withdrawal CPI under any bypass scenario.
        assertKnownProgram(slabProgramId);

        // P-CRITICAL-3: Validate network before withdrawal.
        // Latency: skipped when SlabProvider has already parsed a v17 config
        // for this slab — the provider fetched it over THIS connection, so
        // the market provably exists on the current network and the refetch
        // is a pure round-trip between the click and the wallet popup.
        if (wrapperConfigV17 == null) {
          try {
            const slabInfo = await connection.getAccountInfo(new PublicKey(slabAddress));
            if (!slabInfo) {
              throw new Error("Market not found on current network. Please switch networks in your wallet and refresh.");
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes("Market not found")) throw e;
          }
        }
        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);
        const [vaultPda] = deriveVaultAuthority(programId, slabPk);

        // Determine oracle mode using centralised detectOracleMode (oraclePrice.ts).
        // "pyth-pinned" = Pyth feed; "admin" or "hyperp" = use slab as oracle account.
        const oracleMode = detectOracleMode({ ...mktConfig, oracleModeByte: wrapperConfigV17?.oracleMode });
        const useAdminOracle = oracleMode !== "pyth-pinned";
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions = [];

        // If user is oracle authority, push price first.
        // PERC-8328 / GH#1966: NEVER fall back to a hardcoded price — if we can't get
        // a valid, fresh price from the backend, abort the withdrawal entirely. Pushing a
        // fabricated oracle price (e.g. $1) would cause catastrophic mispricing.
        const userIsOracleAuth = useAdminOracle && mktConfig.oracleAuthority.equals(wallet.publicKey);
        if (userIsOracleAuth) {
          throw new Error(INLINE_ORACLE_PUSH_REMOVED_ERROR);
        }

        // M9: Prefer the already-loaded SlabProvider state (`wrapperConfigV17`)
        // over re-detecting the layout from a fresh, fragile refetch — a
        // transient RPC blip in that refetch used to leave `slabDataForLayout`
        // null and silently default `isV17` to `false`, building a v12-shaped
        // withdraw tx (wrong account list + wrong instruction encoding)
        // against a v17 slab. Only re-detect from a fresh fetch when
        // SlabProvider hasn't parsed a v17 config for this slab yet (e.g. the
        // very first render, before SlabProvider's initial load completes).
        let isV17 = wrapperConfigV17 != null;
        if (!isV17) {
          try {
            const slabInfo = await connection.getAccountInfo(slabPk);
            if (slabInfo?.data) isV17 = isV17Account(new Uint8Array(slabInfo.data));
          } catch { /* fall through — layout detection best-effort */ }
        }
        // Set when the v17 path prepends a crank — bumps the CU budget below.
        let v17CrankIncluded = false;

        if (isV17) {
          // ── v17 withdraw path ─────────────────────────────────────────────
          // v17 Withdraw (tag 4): [owner(signer,w), market(w), portfolio(w), destToken(w), vaultToken(w), vaultAuthority, tokenProgram]
          // No clock, no oracle. crank is NOT prepended (v17 Withdraw is standalone).
          // vaultPda is a program PDA (off-curve) → allowOwnerOffCurve=true (else TokenOwnerOffCurveError)
          const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);

          // Find the user's portfolio account.
          const V17_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
          let portfolioPk: PublicKey | null = params.portfolioPk ?? null;
          let portfolioData: Buffer | null = null;
          if (portfolioPk) {
            try {
              const info = await connection.getAccountInfo(portfolioPk, "confirmed");
              if (info) portfolioData = Buffer.from(info.data);
            } catch { /* best-effort */ }
          } else {
            // Latency: when the shared scan store knows the portfolio's pubkey
            // (its address never changes for a wallet+market), one targeted
            // getAccountInfo replaces the filtered program scan below — the
            // DATA read is equally live either way (withdraw needs fresh data
            // for the free-margin gate and the crank-prepend decision). The
            // owner re-verification below applies to both paths.
            const storePk = getPortfolioRawSnapshot(
              makePortfolioScanKey(programId, slabAddress, wallet.publicKey),
            )?.pubkey;
            if (storePk) {
              try {
                const info = await connection.getAccountInfo(storePk, "confirmed");
                if (info) {
                  const candidateData = Buffer.from(info.data);
                  const candidatePf = parsePortfolioV17(candidateData);
                  if (candidatePf.owner.equals(wallet.publicKey)) {
                    portfolioPk = storePk;
                    portfolioData = candidateData;
                  }
                }
              } catch { /* fall through to the scan */ }
            }
          }
          if (!portfolioPk) try {
            // Mutable owner (SDK PF_OWNER_OFF) is at offset 116, NOT offset 80
            // (offset 80 is provenanceOwner — IMMUTABLE). MintPositionNft moves the
            // mutable owner to the escrow PDA on wrap but leaves provenance pointing
            // at the original wallet, so filtering on 80 would still match a wrapped
            // (NFT-escrowed) portfolio here.
            const portfolioAccounts = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                { memcmp: { offset: 116, bytes: wallet.publicKey.toBase58() } },
              ],
            });
            // Drop the market's LP portfolio BEFORE the sort/pick below —
            // withdraw must never target the LP (owner == wallet only when
            // this wallet is the market's CREATOR). See isLpPortfolio's doc.
            const nonLpPortfolioAccounts = portfolioAccounts.filter(
              ({ account }) => !isLpPortfolio(account.data),
            );
            if (nonLpPortfolioAccounts.length > 0) {
              // M10: getProgramAccounts doesn't guarantee stable ordering
              // across RPC nodes/calls. If more than one account ever matches
              // this owner+market filter, picking an arbitrary array element
              // can select a DIFFERENT portfolio than useDeposit.ts /
              // useUserAccount.ts pick for the exact same wallet+market —
              // withdraw could silently act on a different account than the
              // one the UI displays. Sort deterministically by pubkey so
              // every caller converges on the same account.
              const sortedPortfolios = [...nonLpPortfolioAccounts].sort((a, b) =>
                a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()),
              );
              const d = sortedPortfolios[0].account.data;
              const candidateData = d instanceof Buffer ? d : Buffer.from(d);
              // Defense-in-depth: re-verify the mutable owner actually matches after
              // fetch — memcmp filters are advisory server-side; don't trust blindly.
              try {
                const candidatePf = parsePortfolioV17(candidateData);
                if (candidatePf.owner.equals(wallet.publicKey)) {
                  portfolioPk = sortedPortfolios[0].pubkey;
                  portfolioData = candidateData;
                }
              } catch { /* leave portfolioPk/portfolioData unset — falls through below */ }
            }
          } catch { /* fall through — portfolio lookup is best-effort */ }

          if (!portfolioPk) {
            throw new Error("v17: No portfolio account found for this wallet. Please deposit first to create your portfolio.");
          }

          // Over-withdraw pre-check (defense-in-depth). The DepositWithdrawCard UI
          // already blocks amount > freeMargin, but this guards direct/other
          // callers and turns a confusing on-chain failure into a clear message.
          //
          // M7: gate on FREE margin — capital minus the open position's OWN
          // locked initial margin (computePositionInitialMargin, same formula
          // used by usePortfolio's ROE calc) — not total capital. The old
          // check only bounded against `portfolio.capital`, so an amount that
          // left an open position under-collateralized slipped past this
          // pre-check and was rejected only by the on-chain program with a
          // generic "insufficient margin" revert. This still never blocks a
          // valid withdrawal — it only tightens the early client-side bound
          // to match what the chain will actually allow.
          let hasActiveLegs = false;
          if (portfolioData) {
            try {
              const portfolio = parsePortfolioV17(portfolioData);
              const activeLeg = portfolio.legs.find((l) => l.active);
              hasActiveLegs = activeLeg !== undefined;
              const positionSize = activeLeg ? activeLeg.basisPosQ : 0n;
              // D: mirror OrderTicket/DepositWithdrawCard's 3-step entry-price
              // fallback (on-chain entry_price -> locally-cached -> pnl-implied
              // estimate) instead of ONLY the local cache — a cache miss used
              // to silently resolve to 0n here, which zeroes lockedMargin and
              // lets this pre-check's over-withdraw guard pass an amount that
              // then reverts on-chain. If no entry price can be established at
              // all, fail CLOSED (locked = full capital) rather than open.
              const cachedEntryPrice = getEntryPrice(slabAddress, 0, wallet.publicKey.toBase58());
              const wrapperOracleE6 = mktConfig
                ? sanitizePriceE6(applyInvert(mktConfig.lastEffectivePriceE6, mktConfig.invert))
                : 0n;
              const safePnlForEstimate = isSentinelValue(portfolio.pnl) ? 0n : portfolio.pnl;
              const estimatedEntryPrice = hasActiveLegs && wrapperOracleE6 > 0n
                ? estimateEntryFromPnl(positionSize, safePnlForEstimate, wrapperOracleE6)
                : 0n;
              const effectiveEntryPrice = cachedEntryPrice > 0n ? cachedEntryPrice : estimatedEntryPrice;
              const initialMarginBps = slabParams?.initialMarginBps ?? 1000n;
              const lockedMargin = !hasActiveLegs
                ? 0n
                : effectiveEntryPrice > 0n
                  ? computePositionInitialMargin(positionSize, effectiveEntryPrice, initialMarginBps)
                  : portfolio.capital; // fail closed: no entry price could be established
              const freeMargin = portfolio.capital > lockedMargin ? portfolio.capital - lockedMargin : 0n;
              if (params.amount > freeMargin) {
                throw new Error(
                  hasActiveLegs
                    ? "Withdrawal amount exceeds your free margin. Part of your balance backs an open position — reduce the amount or close the position first."
                    : "Withdrawal amount exceeds your account balance. Reduce the amount and try again.",
                );
              }
            } catch (checkErr) {
              // Re-throw our own validation error; ignore parse failures (best-effort).
              if (
                checkErr instanceof Error &&
                checkErr.message.startsWith("Withdrawal amount exceeds")
              ) {
                throw checkErr;
              }
            }
          }

          // With an OPEN POSITION the program must value the portfolio at fresh
          // state before releasing margin — a standalone withdraw rejects with
          // StaleData (code 19) unless something cranked recently. Trades solve
          // this by prepending PermissionlessCrank(FeeSweep) in the same tx
          // (see useTrade), which is why "close, then withdraw" worked while a
          // plain withdraw said "market data is stale". Mirror the trade flow
          // exactly: crank only when the portfolio has active legs (cranking an
          // empty portfolio returns EngineNonProgress 0x16 and aborts the tx).
          if (hasActiveLegs && portfolioPk) {
            v17CrankIncluded = true;
            const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
              wallet.publicKey, slabPk, portfolioPk,
            ]);
            // For Pyth mode, append oracle feed account as tail (same as useTrade)
            if (!useAdminOracle) {
              crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
            }
            instructions.push(buildIx({
              programId,
              keys: crankKeys,
              data: encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
            }));
          }

          instructions.push(buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
              wallet.publicKey, slabPk, portfolioPk, userAta, vaultTokenAta, vaultPda, WELL_KNOWN.tokenProgram,
            ]),
            data: encodeWithdrawCollateral({ amount: params.amount.toString() }),
          }));
        } else {
          // ── v12 legacy withdraw path ─────────────────────────────────────
          // Always prepend permissionless crank before withdraw.
          // v17: encodePermissionlessCrank replaces encodeKeeperCrank (fundingRateE9 hardcoded 0n).
          instructions.push(buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount]),
            data: encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
          }));

          // v12 withdraw: [owner(signer,w), market(w), vault(w), destToken(w), vaultAuthority, tokenProgram, clock, oracle]
          // NOTE: ACCOUNTS_WITHDRAW_COLLATERAL in the v17 SDK is the 7-account v17 shape.
          // The v12 shape has 8 accounts (adds clock + oracle). Build metas manually for v12.
          instructions.push(buildIx({
            programId,
            keys: [
              { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
              { pubkey: slabPk, isSigner: false, isWritable: true },
              { pubkey: mktConfig.vaultPubkey, isSigner: false, isWritable: true },
              { pubkey: userAta, isSigner: false, isWritable: true },
              { pubkey: vaultPda, isSigner: false, isWritable: false },
              { pubkey: WELL_KNOWN.tokenProgram, isSigner: false, isWritable: false },
              { pubkey: WELL_KNOWN.clock, isSigner: false, isWritable: false },
              { pubkey: oracleAccount, isSigner: false, isWritable: false },
            ],
            data: encodeWithdrawCollateral({ userIdx: params.userIdx, amount: params.amount.toString() }),
          }));
        }

        // 600k CU when the v17 crank rides along (matches useTrade's
        // crank+trade budget); all pre-existing paths keep the original 300k.
        const sig = await sendTx({ connection, wallet, instructions, computeUnits: v17CrankIncluded ? 600_000 : 300_000 });
        // Force immediate slab re-read so balance updates without waiting for the next poll.
        refreshSlab?.();
        setTimeout(() => refreshSlab?.(), 2000);
        return sig;
      } catch (e) {
        const rawMsg = e instanceof Error ? e.message : String(e);
        // M7: don't let a withdraw-specific EngineStale(19) read as
        // transient/auto-fixable — see ENGINE_STALE_WITHDRAW_MESSAGE above.
        setError(isEngineStaleWithdrawError(rawMsg) ? ENGINE_STALE_WITHDRAW_MESSAGE : humanizeError(rawMsg));
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId, slabParams, wrapperConfigV17, refreshSlab]
  );

  return { withdraw, loading, error };
}
