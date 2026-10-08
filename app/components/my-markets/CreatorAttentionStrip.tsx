"use client";

import { FC, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { searchVerifiedPools } from "@/hooks/useDexPoolSearch";
import { fetchTokenMeta } from "@/lib/tokenMeta";
import { getConfig, getNetwork } from "@/lib/config";
import { adoptRecoveredLaunch, recoverLaunchFromChain, RECOVERY_COPY } from "@/lib/launch-recovery";
import { isMarketauthComplete } from "@/lib/market-completeness";
import { loadAllInFlightMarkets } from "@/lib/inFlightMarket";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";
import { useCreateMarket, type KeeperRegisterRetryParams } from "@/hooks/useCreateMarket";
import { isKeeperFeedDead, isEngineCrankStale, summarizeAffectedMarkets } from "./attentionLogic";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/bulk-identity";
import { PER_CREATOR_LIMIT_ROW_COPY, isPerCreatorCapRefusal, registrationCandidates, userFacingRegistrationReason, type KeeperRegisterRequest } from "@/lib/keeper-register-client";

/** The launch's own registration request, as this browser saved it at launch time (the creation-tx
 *  proof, plus the pool / CA / symbol / payload the memo bound). Empty when the launch happened on
 *  another device or the storage is gone. Exported for the test. */
export function savedRegistrationRequests(slab: string): KeeperRegisterRequest[] {
  try {
    return typeof window === "undefined" ? [] : registrationCandidates(slab, window.localStorage);
  } catch {
    return [];
  }
}

/** The name a market goes by in this strip: the identity ticker, else the ticker in this browser's saved
 *  registration request for the launch, else the address label. An "UNKNOWN" placeholder is not a ticker. */
export function attentionMarketName(
  slab: string,
  label: string,
  resolvedSymbol: string | null | undefined,
  saved: readonly KeeperRegisterRequest[] = savedRegistrationRequests(slab),
): string {
  if (resolvedSymbol) return resolvedSymbol;
  for (const req of saved) {
    const sym = req.symbol?.trim();
    if (sym && sym.toUpperCase() !== "UNKNOWN") return sym;
  }
  return label;
}

export const NO_SAVED_REGISTRATION_COPY =
  "this launch never finished connecting its live price, and this browser doesn't have its details. Enter the token's address: they are rebuilt from the chain and checked against the registration signed when you launched.";

/**
 * The cross-device path (#3267): no saved request on this device, so ask for the token's mainnet address,
 * rebuild the request from chain and prove it against the memo in the creation transaction, then send it.
 * The route re-verifies the same memo; this only avoids sending what cannot verify and keeps the flow to
 * the market's own creator.
 */
const RecoverFromChainForm: FC<{
  slab: string;
  retry: (p: KeeperRegisterRetryParams) => Promise<{ registered: boolean; message: string; code?: string }>;
  registering: boolean;
}> = ({ slab, retry, registering }) => {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [ca, setCa] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);
  const submit = async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await recoverLaunchFromChain(
        {
          connection,
          wrapperProgramId: getConfig().programId as string,
          crankWallet: getConfig().crankWallet as string | undefined,
          isDevnetEnv: getNetwork() === "devnet",
          searchPools: (m) => searchVerifiedPools(m),
          fetchMeta: (m) => fetchTokenMeta(connection, m),
        },
        { slab, wallet: wallet.publicKey.toBase58(), mainnetCA: ca },
      );
      if (!r.ok) {
        setNote(RECOVERY_COPY[r.reason]);
        return;
      }
      // Only a request that matched the on-chain memo gets here. Save what the launching browser
      // would have, then send it through the same path as the saved retry.
      adoptRecoveredLaunch(r.launch);
      const res = await retry({
        slabAddress: slab,
        mainnetCA: r.launch.request.mainnetCA ?? null,
        dexPoolAddress: r.launch.request.dexPoolAddress,
        dexType: r.launch.request.dexType ?? null,
        symbol: r.launch.request.symbol ?? null,
        payload: r.launch.request.payload ?? null,
      });
      if (!res.registered && isPerCreatorCapRefusal(res)) setLimit(true);
      setNote(res.registered ? null : userFacingRegistrationReason(res.message));
    } catch {
      setNote(RECOVERY_COPY.rpc);
    } finally {
      setBusy(false);
    }
  };
  if (limit) {
    return (
      <span data-testid="per-creator-limit-note" className="max-w-[28rem] text-right text-[10px] text-[var(--text-dim)]">
        {PER_CREATOR_LIMIT_ROW_COPY}
      </span>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <input
          data-testid="register-from-chain-ca"
          value={ca}
          onChange={(e) => setCa(e.target.value)}
          placeholder="token address (mainnet)"
          className="w-64 border border-[var(--border)]/50 bg-transparent px-2 py-1.5 text-[10px] text-[var(--text)] outline-none focus:border-[var(--warning)]/50"
          style={{ fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          data-testid="register-from-chain-submit"
          disabled={busy || registering || !ca.trim() || !wallet.publicKey}
          onClick={submit}
          className="border border-[var(--warning)]/50 bg-[var(--warning)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/[0.15] disabled:opacity-50"
        >
          {busy || registering ? "checking…" : "verify and connect"}
        </button>
      </div>
      {note && <span data-testid="register-from-chain-note" className="max-w-[28rem] text-right text-[10px] text-[var(--text-dim)]">{note}</span>}
    </div>
  );
};

/** One "connect the live price" row. Its own useCreateMarket() instance so
 *  N dead-feed markets in the strip have independent loading/message state
 *  instead of sharing one global "registering…" flag. */
const KeeperRetryRow: FC<{ market: CreatedMarket; detail: CreatorMarketDetail | null; identity: ResolvedIdentity | null }> = ({ market, detail, identity }) => {
  const { state, retryKeeperRegistration } = useCreateMarket();
  const slab = market.slabAddress.toBase58();
  // Same field-level merge the row uses, so the alert names the market by
  // its real ticker even before the per-market detail lands.
  const resolved = resolveIdentity(detail, identity);
  // NOT merged: the bulk directory does not carry dex_pool_address, and this
  // value is passed to a real transaction, not rendered. Detail only.
  const dexPoolAddress = detail?.dex_pool_address;
  // No pool on the markets row = the registration never landed (an "UNKNOWN" placeholder). The
  // launching browser still holds the creation-tx proof and the exact request the memo bound, so the
  // creator can retry from here; only a launch from another device has nothing to send.
  const savedAll = useMemo(() => savedRegistrationRequests(slab), [slab]);
  const saved = dexPoolAddress ? [] : savedAll;
  const symbol = attentionMarketName(slab, market.label, resolved.symbol, savedAll);
  // The per-wallet limit is final; once the route says so, the button is replaced.
  const [limitReached, setLimitReached] = useState(false);
  const [savedBusy, setSavedBusy] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
      <div>
        <span className="text-[11px] font-semibold text-[var(--text)]">{symbol}</span>
        <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
          the live price isn&apos;t connected — new positions may be blocked until it is.
        </span>
        {state.keeperMessage && (
          <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">{state.keeperMessage}</p>
        )}
      </div>
      {dexPoolAddress ? (
        <button
          type="button"
          disabled={state.keeperRegistering}
          onClick={() => {
            const params: KeeperRegisterRetryParams = {
              slabAddress: slab,
              mainnetCA: detail?.mainnet_ca ?? null,
              dexPoolAddress,
              symbol: resolved.symbol,
            };
            retryKeeperRegistration(params);
          }}
          className="shrink-0 border border-[var(--warning)]/50 bg-[var(--warning)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] hover:bg-[var(--warning)]/[0.15] transition-colors disabled:opacity-50"
        >
          {state.keeperRegistering ? "registering…" : "connect the live price"}
        </button>
      ) : saved.length > 0 && limitReached ? (
        <span data-testid="per-creator-limit-note" className="max-w-[28rem] text-right text-[10px] text-[var(--text-dim)]">
          {PER_CREATOR_LIMIT_ROW_COPY}
        </span>
      ) : saved.length > 0 ? (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            disabled={savedBusy}
            onClick={async () => {
              setSavedBusy(true);
              setSavedNote(null);
              let last = "";
              let limit = false;
              for (const req of saved) {
                const r = await retryKeeperRegistration({
                  slabAddress: slab,
                  mainnetCA: req.mainnetCA ?? null,
                  dexPoolAddress: req.dexPoolAddress,
                  dexType: req.dexType ?? null,
                  symbol: req.symbol ?? null,
                  payload: req.payload ?? null,
                });
                if (r.registered) {
                  last = "";
                  break;
                }
                last = r.message;
                if (isPerCreatorCapRefusal(r)) {
                  limit = true;
                  break;
                }
              }
              if (limit) setLimitReached(true);
              setSavedNote(last ? userFacingRegistrationReason(last) : null);
              setSavedBusy(false);
            }}
            className="border border-[var(--warning)]/50 bg-[var(--warning)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] hover:bg-[var(--warning)]/[0.15] transition-colors disabled:opacity-50"
          >
            {savedBusy || state.keeperRegistering ? "registering…" : "connect the live price"}
          </button>
          {savedNote && <span className="max-w-[28rem] text-right text-[10px] text-[var(--text-dim)]">{savedNote}</span>}
        </div>
      ) : (
        <div className="flex flex-col items-end gap-2">
          <span className="max-w-[28rem] text-right text-[10px] text-[var(--text-dim)]">{NO_SAVED_REGISTRATION_COPY}</span>
          <RecoverFromChainForm slab={slab} retry={retryKeeperRegistration} registering={state.keeperRegistering} />
        </div>
      )}
    </div>
  );
};

/**
 * (a) An unfinished launch, found from CHAIN (the market's marketauth is still this wallet), so it shows on any
 * device. A launch this browser started has its own recovery card (RecoverSolBanner) and is skipped here.
 * Continue opens /create?resume=<slab>, which rebuilds the launch from chain (#3267).
 */
const UnfinishedLaunchRow: FC<{ market: CreatedMarket; name: string | null }> = ({ market, name }) => {
  const slab = market.slabAddress.toBase58();
  return (
    <div data-testid="unfinished-launch-row" className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
      <div>
        <span className="text-[11px] font-semibold text-[var(--text)]">{name ?? "Launch unfinished"}</span>
        <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
          {name ? "launch unfinished. " : ""}It stopped before its last step. Continue it here, from any device, or reclaim its rent from the market&apos;s row below if nothing is deposited yet.
        </span>
      </div>
      <Link
        href={`/create?resume=${slab}`}
        data-testid="unfinished-launch-continue"
        className="shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15]"
      >
        continue launch
      </Link>
    </div>
  );
};

/** Chain-detected unfinished launches with no recovery card on this device. Exported for the test. */
export function unfinishedLaunchesWithoutLocalRecord(markets: CreatedMarket[], localSlabs: ReadonlySet<string>): CreatedMarket[] {
  return markets.filter((m) => {
    const marketauth = m.configV17?.marketauth;
    if (!marketauth) return false;
    return !isMarketauthComplete(marketauth, m.slabAddress) && !localSlabs.has(m.slabAddress.toBase58());
  });
}

interface CreatorAttentionStripProps {
  markets: CreatedMarket[];
  details: Record<string, CreatorMarketDetail | null>;
  identities: Record<string, ResolvedIdentity>;
  currentSlot: bigint | null;
}

/**
 * Modeled on components/portfolio/AtRiskBanner.tsx — renders nothing (zero
 * height) when there is nothing to flag. Independent conditions, each its own
 * section so one noisy condition never crowds out another:
 *  (a) stuck/incomplete launches — RecoverSolBanner, reused verbatim.
 *  (b) keeper-fed markets with a dead price feed — retry wiring (see above).
 *  (c) engine-crank-stale markets — informational + link, deliberately NO
 *      button: there is no self-service fix (the accrue cliff clears itself
 *      once someone next trades/cranks the market; a "fix it" button would
 *      be a lie).
 *
 * Deviation from the build plan: the plan also listed an optional (d) "admin
 * key still live" informational row. Skipped deliberately — every single
 * market on this page is, by construction, one this wallet administers (a
 * burned key makes the market vanish from the scan on its next poll), so
 * "admin key still live" is true for 100% of rows on every page load. That's
 * not an exception to flag, it's the default state; surfacing it here would
 * violate this component's own "zero height unless something is actually
 * wrong" contract and just be alert fatigue with no action attached. Each
 * row's drawer already carries its own burn control for the rare case a
 * creator wants it — no strip nudge needed.
 */
export const CreatorAttentionStrip: FC<CreatorAttentionStripProps> = ({ markets, details, identities, currentSlot }) => {
  const keeperDead = markets.filter((m) => isKeeperFeedDead(m, currentSlot));
  const crankStale = markets.filter((m) => isEngineCrankStale(m, currentSlot));

  // Name the affected markets, capped — informative without becoming the list
  // this summary exists to remove. Same field-level identity merge as
  // KeeperRetryRow, so the two lines in one strip cannot disagree about a
  // market's name while the detail fetch is in flight.
  const crankStaleLabel = summarizeAffectedMarkets(
    crankStale.map((m) => {
      const slab = m.slabAddress.toBase58();
      return attentionMarketName(slab, m.label, resolveIdentity(details[slab] ?? null, identities[slab] ?? null).symbol);
    }),
  );

  const localSlabs = useMemo(() => {
    try {
      return new Set(loadAllInFlightMarkets().map((x) => x.slabAddress));
    } catch {
      return new Set<string>();
    }
  }, [markets]);
  const unfinished = unfinishedLaunchesWithoutLocalRecord(markets, localSlabs);
  const hasAnything = keeperDead.length > 0 || crankStale.length > 0 || unfinished.length > 0;

  return (
    <div>
      {/* (a) stuck/incomplete launches */}
      <RecoverSolBanner />

      {!hasAnything ? null : (
        <div className="mb-6 divide-y divide-[var(--border)]/40 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.03]">
          {/* (a) unfinished launches, from chain: continue from any device */}
          {unfinished.map((m) => {
            const slab = m.slabAddress.toBase58();
            const sym = resolveIdentity(details[slab] ?? null, identities[slab] ?? null).symbol;
            return <UnfinishedLaunchRow key={slab} market={m} name={sym && sym !== "UNKNOWN" ? sym : null} />;
          })}

          {/* (b) keeper-fed, dead price feed — the highest-value new wiring here */}
          {keeperDead.map((m) => (
            <KeeperRetryRow key={m.slabAddress.toBase58()} market={m} detail={details[m.slabAddress.toBase58()] ?? null} identity={identities[m.slabAddress.toBase58()] ?? null} />
          ))}

          {/* (c) engine crank stale — ONE summary line, not a row per market.
              This used to render one row per stale market, which on a quiet
              devnet reproduced the creator's entire market list above the real
              one (#2573). It earns a list less than anything else here: it is
              explicitly informational with no self-service fix, AND every row
              in the real list below already carries a pulsing crank-freshness
              dot with the same tooltip, so the per-market detail was never
              lost by summarising it. */}
          {crankStale.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="text-[11px] font-semibold text-[var(--text)]">
                {crankStale.length === 1
                  ? "1 market is catching up"
                  : `${crankStale.length} markets are catching up`}
              </span>
              <span className="text-[10px] text-[var(--text-secondary)]">
                {crankStaleLabel} — each catches up automatically once it is next traded or
                updated; the pulsing dot on a row below marks which.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
