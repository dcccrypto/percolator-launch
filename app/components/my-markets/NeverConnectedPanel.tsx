"use client";

/**
 * /my-markets: a market whose price never connected, and the way to get the money back (#3637, lifecycle plan §5).
 *
 * It lists the creator's own never-connected markets found ON CHAIN (hooks/useNeverConnectedMarkets.ts), so it shows for a
 * market with no registry row, which every other surface on this page cannot. Per market it says plainly that the price never
 * connected, when anyone can settle it (countdown from `permissionless_resolve_stale_slots`), offers Settle once matured
 * (hooks/useStaleResolve.ts, unchanged), then links the existing exits. Nothing is sent except by the Settle click.
 *
 * Composes with #3676: that PR makes the launch screen and the creator row say the price cannot connect; this panel is the
 * "what now" for the same market. A final refusal that #3676 recorded on this device (`isRegistrationRefused`) corroborates the
 * chain read and keeps the market listed when its history cannot be read.
 */
import { type FC } from "react";
import Link from "next/link";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { useStaleResolve } from "@/hooks/useStaleResolve";
import { useNeverConnectedMarkets } from "@/hooks/useNeverConnectedMarkets";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { getNetwork } from "@/lib/config";
import { isRegistrationRefused } from "@/lib/keeper-register-client";
import { STALE_SETTLE_COPY } from "@/lib/v22/stale-resolve";
import {
  NEVER_CONNECTED_COPY,
  RECOVER_STEPS,
  neverConnectedView,
  phaseLine,
  rentRefundCopy,
  type NeverConnectedView,
  type RefundNetwork,
} from "@/lib/v22/never-connected";

export interface NeverConnectedCardViewProps {
  slab: string;
  view: NeverConnectedView;
  network: RefundNetwork;
  canAct: boolean;
  busy: boolean;
  error: string | null;
  done: string | null;
  waiting: string | null;
  onSettle: () => void;
}

/** Pure renderer (tested without a provider). */
export const NeverConnectedCardView: FC<NeverConnectedCardViewProps> = ({ slab, view, network, canAct, busy, error, done, waiting, onSettle }) => (
  <section data-testid="never-connected-card" data-phase={view.phase} data-slab={slab} className="mb-4 border border-[var(--warning)]/40 bg-[var(--warning)]/[0.04] p-4 text-[12px]">
    <h2 className="text-[11px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">{NEVER_CONNECTED_COPY.title}</h2>
    <p className="mt-1 font-mono text-[10px] text-[var(--text-muted)]" data-testid="never-connected-slab">{slab.slice(0, 8)}…{slab.slice(-4)}</p>
    <p className="mt-3 text-[var(--text)]" data-testid="never-connected-lead">
      {view.evidence === "registration" ? NEVER_CONNECTED_COPY.registrationOnly : NEVER_CONNECTED_COPY.lead}
    </p>
    <p className="mt-2 text-[var(--text-secondary)]" data-testid="never-connected-status">{phaseLine(view)}</p>

    {view.phase === "settle" && canAct && !done && (
      <div className="mt-3">
        <button
          type="button"
          data-testid="never-connected-settle"
          onClick={onSettle}
          disabled={busy}
          className="border border-[var(--border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? STALE_SETTLE_COPY.busy : STALE_SETTLE_COPY.button}
        </button>
        <p className="mt-1 text-[10px] text-[var(--text-muted)]">{NEVER_CONNECTED_COPY.settleNote}</p>
      </div>
    )}
    {done && <p className="mt-2 text-[var(--long)]" data-testid="never-connected-done">{done}</p>}
    {waiting && !done && <p className="mt-2 text-[var(--text-secondary)]" data-testid="never-connected-waiting">{waiting}</p>}
    {error && <p role="alert" className="mt-2 text-[var(--short)]" data-testid="never-connected-error">{error}</p>}

    {view.phase !== "no-path" && (
      <div className="mt-4" data-testid="never-connected-steps">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">{NEVER_CONNECTED_COPY.stepsTitle}</h3>
        <ul className="mt-2 space-y-2">
          {RECOVER_STEPS.map((s) => (
            <li key={s.id} data-testid={`never-connected-step-${s.id}`}>
              <p className="text-[var(--text)]">{s.title}</p>
              <p className="text-[var(--text-secondary)]">{s.body}</p>
              <Link href={s.href(slab)} className="text-[10px] uppercase tracking-[0.1em] text-[var(--accent)] underline underline-offset-2">
                {s.linkLabel}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    )}

    <div className="mt-4" data-testid="never-connected-rent" data-network={network}>
      <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">{NEVER_CONNECTED_COPY.rentTitle}</h3>
      {rentRefundCopy(network).map((line) => (
        <p key={line} className="mt-1 text-[var(--text-secondary)]">{line}</p>
      ))}
    </div>
  </section>
);

const Card: FC<{ slab: string; creationSlot: bigint | null; refused: boolean; network: RefundNetwork }> = ({ slab, creationSlot, refused, network }) => {
  const { raw } = useSlabState();
  const clusterSlot = useClusterSlot(isDevnetV22Enabled());
  const { publicKey } = useWalletCompat();
  const s = useStaleResolve(slab, true);
  const view = neverConnectedView({ raw, clusterSlot, creationSlot, registrationRefused: refused });
  if (!view) return null;
  return (
    <NeverConnectedCardView
      slab={slab}
      view={view}
      network={network}
      canAct={publicKey !== null}
      busy={s.busy}
      error={s.error}
      done={s.done}
      waiting={s.waiting}
      onSettle={() => void s.settle()}
    />
  );
};

const refusedOnDevice = (slab: string): boolean => isRegistrationRefused(slab);

const Inner: FC = () => {
  const { markets } = useNeverConnectedMarkets(refusedOnDevice);
  const network: RefundNetwork = getNetwork();
  if (markets.length === 0) return null;
  return (
    <div data-testid="never-connected-panel">
      {markets.map((m) => (
        <SlabProvider key={m.slab} slabAddress={m.slab}>
          <Card slab={m.slab} creationSlot={m.creationSlot} refused={refusedOnDevice(m.slab)} network={network} />
        </SlabProvider>
      ))}
    </div>
  );
};

/** Mount point. Renders nothing (and runs no lookup) unless the v2.2 build is on. */
export const NeverConnectedPanel: FC = () => (isDevnetV22Enabled() ? <Inner /> : null);
