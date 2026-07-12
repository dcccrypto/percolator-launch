"use client";

import { FC } from "react";
import Link from "next/link";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";
import { useCreateMarket, type KeeperRegisterRetryParams } from "@/hooks/useCreateMarket";
import { isKeeperFeedDead, isEngineCrankStale } from "./attentionLogic";

/** One "retry keeper registration" row. Its own useCreateMarket() instance so
 *  N dead-feed markets in the strip have independent loading/message state
 *  instead of sharing one global "registering…" flag. */
const KeeperRetryRow: FC<{ market: CreatedMarket; detail: CreatorMarketDetail | null }> = ({ market, detail }) => {
  const { state, retryKeeperRegistration } = useCreateMarket();
  const slab = market.slabAddress.toBase58();
  const symbol = detail?.symbol ?? market.label;
  const dexPoolAddress = detail?.dex_pool_address;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
      <div>
        <span className="text-[11px] font-semibold text-[var(--text)]">{symbol}</span>
        <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
          keeper price feed looks dead — new positions may be blocked until it&apos;s re-registered.
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
              symbol: detail?.symbol ?? null,
            };
            retryKeeperRegistration(params);
          }}
          className="shrink-0 border border-[var(--warning)]/50 bg-[var(--warning)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] hover:bg-[var(--warning)]/[0.15] transition-colors disabled:opacity-50"
        >
          {state.keeperRegistering ? "registering…" : "retry keeper registration"}
        </button>
      ) : (
        <span className="shrink-0 text-[10px] text-[var(--text-dim)]">
          no DEX pool on record — can&apos;t auto-retry, contact support
        </span>
      )}
    </div>
  );
};

interface CreatorAttentionStripProps {
  markets: CreatedMarket[];
  details: Record<string, CreatorMarketDetail | null>;
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
export const CreatorAttentionStrip: FC<CreatorAttentionStripProps> = ({ markets, details, currentSlot }) => {
  const keeperDead = markets.filter((m) => isKeeperFeedDead(m, currentSlot));
  const crankStale = markets.filter((m) => isEngineCrankStale(m, currentSlot));

  const hasAnything = keeperDead.length > 0 || crankStale.length > 0;

  return (
    <div>
      {/* (a) stuck/incomplete launches */}
      <RecoverSolBanner />

      {!hasAnything ? null : (
        <div className="mb-6 divide-y divide-[var(--border)]/40 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.03]">
          {/* (b) keeper-fed, dead price feed — the highest-value new wiring here */}
          {keeperDead.map((m) => (
            <KeeperRetryRow key={m.slabAddress.toBase58()} market={m} detail={details[m.slabAddress.toBase58()] ?? null} />
          ))}

          {/* (c) engine crank stale — informational only, no fake fix button */}
          {crankStale.map((m) => {
            const slab = m.slabAddress.toBase58();
            const symbol = details[slab]?.symbol ?? m.label;
            return (
              <div key={slab} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <div>
                  <span className="text-[11px] font-semibold text-[var(--text)]">{symbol}</span>
                  <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
                    engine crank is stale (accrue cliff) — no self-service fix; it clears once the market is next traded or externally cranked.
                  </span>
                </div>
                <Link href={`/trade/${slab}`} className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-[var(--accent)] hover:brightness-125">
                  open market →
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
