"use client";

import { FC, useMemo, useState } from "react";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";
import { useCreateMarket, type KeeperRegisterRetryParams } from "@/hooks/useCreateMarket";
import { isKeeperFeedDead, isEngineCrankStale, summarizeAffectedMarkets } from "./attentionLogic";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/bulk-identity";
import { registrationCandidates, userFacingRegistrationReason, type KeeperRegisterRequest } from "@/lib/keeper-register-client";

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

export const NO_SAVED_REGISTRATION_COPY =
  "this launch never finished connecting its live price, and this browser doesn't have its details to send again. Open My Markets from the browser you launched it on, or ask us to connect it.";

/** One "connect the live price" row. Its own useCreateMarket() instance so
 *  N dead-feed markets in the strip have independent loading/message state
 *  instead of sharing one global "registering…" flag. */
const KeeperRetryRow: FC<{ market: CreatedMarket; detail: CreatorMarketDetail | null; identity: ResolvedIdentity | null }> = ({ market, detail, identity }) => {
  const { state, retryKeeperRegistration } = useCreateMarket();
  const slab = market.slabAddress.toBase58();
  // Same field-level merge the row uses, so the alert names the market by
  // its real ticker even before the per-market detail lands.
  const resolved = resolveIdentity(detail, identity);
  const symbol = resolved.symbol ?? market.label;
  // NOT merged: the bulk directory does not carry dex_pool_address, and this
  // value is passed to a real transaction, not rendered. Detail only.
  const dexPoolAddress = detail?.dex_pool_address;
  // No pool on the markets row = the registration never landed (an "UNKNOWN" placeholder). The
  // launching browser still holds the creation-tx proof and the exact request the memo bound, so the
  // creator can retry from here; only a launch from another device has nothing to send.
  const saved = useMemo(() => (dexPoolAddress ? [] : savedRegistrationRequests(slab)), [dexPoolAddress, slab]);
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
      ) : saved.length > 0 ? (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            disabled={savedBusy}
            onClick={async () => {
              setSavedBusy(true);
              setSavedNote(null);
              let last = "";
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
              }
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
        <span className="max-w-[28rem] shrink-0 text-[10px] text-[var(--text-dim)]">{NO_SAVED_REGISTRATION_COPY}</span>
      )}
    </div>
  );
};

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
      return resolveIdentity(details[slab] ?? null, identities[slab] ?? null).symbol ?? m.label;
    }),
  );

  const hasAnything = keeperDead.length > 0 || crankStale.length > 0;

  return (
    <div>
      {/* (a) stuck/incomplete launches */}
      <RecoverSolBanner />

      {!hasAnything ? null : (
        <div className="mb-6 divide-y divide-[var(--border)]/40 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.03]">
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
