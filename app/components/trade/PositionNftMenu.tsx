"use client";

/**
 * UX WP-9 (audit §3.13, NF-1..3): the position NFT actions live in the position row's "⋯" menu
 * (desktop and mobile), not in the ticket rail: "Wrap as NFT" (with a confirm sheet), "Send NFT"
 * (the checkbox modal, plain copy) and "Unwrap" (one prompt: EmergencyBurn directly when the
 * position already closed, useBurnPositionNft). Replaces PositionNftPanel (removed from the rail).
 * The eligibility logic is PositionNftPanel's, unchanged (#13: mint only on the wallet's own
 * unwrapped leg; send / unwrap act on the NFT actually held, self-minted or received).
 * ClosedPositionNftNotice covers the one case the row menu can't: a wrapped position that closed, which has no row.
 */
import { formatLotQ, lotExpOf } from "@/lib/v22/lot";
import { type FC, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { usePositionNft } from "@/hooks/usePositionNft";
import { useMintPositionNft } from "@/hooks/useMintPositionNft";
import { useBurnPositionNft } from "@/hooks/useBurnPositionNft";
import { useTransferPositionNft } from "@/hooks/useTransferPositionNft";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { formatTokenAmount } from "@/lib/format";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { SendPositionNftModal } from "@/components/trade/SendPositionNftModal";

export const NFT_MENU_COPY = {
  menuLabel: "More position actions",
  wrap: "Wrap as NFT",
  send: "Send NFT",
  unwrap: "Unwrap",
  wrapTitle: "Wrap position as an NFT",
  wrapBody: (collateral: string) =>
    `Your whole trading account on this market (the position and all ${collateral} of its collateral) moves into the NFT. Whoever holds the NFT controls it. Unwrap any time to get it back.`,
  wrapConfirm: "Wrap · 1 approval",
  cancel: "Cancel",
  badge: "NFT",
  closeWrapped: "Unwrap to close this position",
  /** The dock's wrapped-position banner: names the ⋯ button and this menu's Unwrap item. */
  wrappedHint: "Wrapped in Position NFT — Unwrap it from the ⋯ menu to close",
  /** The order ticket's Close tab when this market's position is wrapped (the ticket can't close it). */
  closeTabTitle: "Position wrapped as an NFT",
  closeTabBody: (side: "long" | "short") =>
    `Your ${side} on this market is held in a Position NFT, so it can't be closed here. Unwrap it from the ⋯ menu on its row in Positions, then close it.`,
  heldElsewhere: "Held as an NFT by another wallet",
  closedTitle: "Your NFT-wrapped position has closed",
  closedBody: "Unwrap the NFT to get back any collateral left in it.",
} as const;

export interface PositionNftMenuViewProps {
  canWrap: boolean;
  isWrapped: boolean;
  collateralLabel: string;
  busy: "wrap" | "send" | "unwrap" | null;
  error: string | null;
  onWrap: () => void;
  onSend: () => void;
  onUnwrap: () => void;
}

export const PositionNftMenuView: FC<PositionNftMenuViewProps> = ({ canWrap, isWrapped, collateralLabel, busy, error, onWrap, onSend, onUnwrap }) => {
  const [open, setOpen] = useState(false);
  const [confirmWrap, setConfirmWrap] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Keyboard: Escape closes and returns focus to the ⋯ button.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    // Focus the first item so Tab / Enter work inside the menu.
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!canWrap && !isWrapped) return null;
  const item = "block w-full px-3 py-2 text-left text-[11px] text-[var(--text)] hover:bg-[var(--accent)]/[0.08] disabled:opacity-40 min-h-[44px] md:min-h-0";
  return (
    <div
      ref={ref}
      className="relative inline-block"
      data-testid="position-nft-menu"
      // Tabbing out of an open menu closes it, so it can't linger behind other UI.
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="position-nft-menu-button"
        aria-label={NFT_MENU_COPY.menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="min-h-[44px] min-w-[44px] px-2 text-[14px] leading-none text-[var(--text-secondary)] hover:text-[var(--text)] md:min-h-0 md:min-w-0"
      >
        ⋯
      </button>
      {open && (
        <div ref={menuRef} role="menu" className="absolute right-0 z-30 mt-1 min-w-[160px] border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-lg">
          {canWrap && (
            <button role="menuitem" type="button" data-testid="position-nft-wrap" className={item} disabled={busy !== null} onClick={() => {
                // Focus ⋯ before the menu unmounts, so the sheet (Modal) restores focus to it on close.
                buttonRef.current?.focus();
                setOpen(false);
                setConfirmWrap(true);
              }}>
              {NFT_MENU_COPY.wrap}
            </button>
          )}
          {isWrapped && (
            <>
              <button role="menuitem" type="button" data-testid="position-nft-send" className={item} disabled={busy !== null} onClick={() => { setOpen(false); onSend(); }}>
                {NFT_MENU_COPY.send}
              </button>
              <button role="menuitem" type="button" data-testid="position-nft-unwrap" className={item} disabled={busy !== null} onClick={() => { setOpen(false); onUnwrap(); }}>
                {busy === "unwrap" ? "Unwrapping…" : NFT_MENU_COPY.unwrap}
              </button>
            </>
          )}
        </div>
      )}
      {/* The shared Modal: Escape, focus trap and restore, scroll lock, and a portal above the
          mobile tab bar (inline, the trade page's animate-fade-in root capped its z-index and
          the bottom tab bar covered Cancel / Wrap). */}
      {confirmWrap && (
        <Modal
          onClose={() => setConfirmWrap(false)}
          labelledBy="wrap-nft-title"
          panelClassName="w-full max-w-md border border-[var(--border)] bg-[var(--bg)] p-5 text-left"
        >
          <div data-testid="position-nft-wrap-sheet">
            <h3 id="wrap-nft-title" className="text-[13px] font-semibold text-[var(--text)]">{NFT_MENU_COPY.wrapTitle}</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">{NFT_MENU_COPY.wrapBody(collateralLabel)}</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setConfirmWrap(false)} className="min-h-[44px] flex-1 border border-[var(--border)] text-[11px] text-[var(--text-secondary)]">
                {NFT_MENU_COPY.cancel}
              </button>
              <button
                type="button"
                data-testid="position-nft-wrap-confirm"
                disabled={busy !== null}
                onClick={() => { setConfirmWrap(false); onWrap(); }}
                className="min-h-[44px] flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] text-[11px] font-semibold text-[var(--accent)] disabled:opacity-40"
              >
                {NFT_MENU_COPY.wrapConfirm}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {error && (
        <p data-testid="position-nft-error" className="mt-1 max-w-[220px] text-right text-[10px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};

/** The container: PositionNftPanel's hooks and eligibility, behind the row menu.
 *  Audit #40: `row` binds the menu to the row it sits on when the wallet holds
 *  BOTH an owned and a wrapped position on one market — "own" offers only Wrap
 *  (never Send/Unwrap aimed at the hidden wrapped position), "wrapped" offers
 *  only Send/Unwrap. Omitted = the legacy merged behavior. */
export const PositionNftMenu: FC<{ slabAddress: string; row?: "own" | "wrapped" }> = ({ slabAddress, row }) => {
  const userAccount = useUserAccount();
  const { hasMintedNft, nftMint, nftPdaAddress } = usePositionNft(slabAddress);
  const { mint: mintNft, loading: mintLoading, error: mintError } = useMintPositionNft(slabAddress);
  const wrappedScan = useNftWrappedPosition(slabAddress, true);
  const wrapped = row === "own" ? null : wrappedScan;
  // Unscoped on purpose: it also clears `pendingMint` below, and a mint's NFT
  // may first surface via either source regardless of which row this menu is on.
  const isNftPresent = hasMintedNft || wrappedScan !== null;
  const effectiveNftMint = wrapped?.nftMint ?? nftMint;
  const effectiveNftPdaAddress = wrapped?.nftPda.toBase58() ?? nftPdaAddress;
  const nftOverride = effectiveNftMint && effectiveNftPdaAddress ? { nftMint: effectiveNftMint, nftPdaAddress: effectiveNftPdaAddress } : undefined;
  const { burn, loading: burnLoading, error: burnError } = useBurnPositionNft(slabAddress, nftOverride);
  const { transfer, loading: transferLoading, error: transferError } = useTransferPositionNft(slabAddress, nftOverride && { nftMint: nftOverride.nftMint });
  const { config, raw: slabRaw } = useSlabState();
  const meta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = meta?.decimals ?? 6;
  const collateralSymbol = meta?.symbol ?? "USDC";
  const marketInfo = useMarketInfo(slabAddress);
  const assetSymbol = sanitizeSymbol(marketInfo.market?.symbol) ?? "SIZE";
  const [showSend, setShowSend] = useState(false);
  const [pendingMint, setPendingMint] = useState(false);
  useEffect(() => {
    if (isNftPresent) setPendingMint(false);
  }, [isNftPresent]);

  const own = row !== "wrapped" && userAccount !== null && userAccount.account.positionSize !== 0n ? userAccount : null;
  const effective = wrapped ?? own;
  const mintAddress = effectiveNftMint?.toBase58() ?? null;
  const summary =
    effective && effective.account.positionSize !== 0n
      ? `${effective.account.positionSize > 0n ? "LONG" : "SHORT"} ${formatLotQ(effective.account.positionSize < 0n ? -effective.account.positionSize : effective.account.positionSize, decimals, lotExpOf(slabRaw))} ${assetSymbol}`
      : "No open position";
  const collateralLabel = own ? `${formatTokenAmount(own.account.capital, decimals)} ${collateralSymbol}` : `the ${collateralSymbol}`;
  const busy = mintLoading || pendingMint ? "wrap" : transferLoading ? "send" : burnLoading ? "unwrap" : null;

  return (
    <>
      <PositionNftMenuView
        canWrap={own !== null && !pendingMint}
        isWrapped={row === "own" ? false : isNftPresent}
        collateralLabel={collateralLabel}
        busy={busy}
        error={mintError || burnError || transferError}
        onWrap={() => {
          setPendingMint(true);
          void mintNft().then((sig) => {
            if (!sig) setPendingMint(false);
          });
        }}
        onSend={() => setShowSend(true)}
        onUnwrap={() => void burn()}
      />
      {showSend && isNftPresent && mintAddress && (
        <SendPositionNftModal
          positionSummary={summary}
          nftMintShort={`${mintAddress.slice(0, 8)}…${mintAddress.slice(-6)}`}
          loading={transferLoading}
          error={transferError}
          onCancel={() => setShowSend(false)}
          onConfirm={async (dest) => {
            const sig = await transfer(dest);
            if (sig) setShowSend(false);
          }}
        />
      )}
    </>
  );
};

/**
 * H8: a position closed while wrapped (liquidated) has no row in the dock — useNftWrappedPosition skips size-0
 * legs — so the row's "⋯" menu never mounts and nothing offered Unwrap. Shown under the empty state instead.
 * Unwrap routes to EmergencyBurn itself on LegNotActive (useBurnPositionNft, NF-2). No Send: a closed leg can't
 * be transferred. Hidden once an unwrap lands, so a click during the rescan can't hit "already burned?".
 */
export const ClosedPositionNftNotice: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { hasMintedNft, pendingSettlement, nftMint, nftPdaAddress } = usePositionNft(slabAddress);
  const { burn, loading, error } = useBurnPositionNft(
    slabAddress,
    nftMint && nftPdaAddress ? { nftMint, nftPdaAddress } : undefined,
  );
  const [burnedPda, setBurnedPda] = useState<string | null>(null);
  if (!hasMintedNft || !pendingSettlement || !nftPdaAddress || burnedPda === nftPdaAddress) return null;
  return (
    <div data-testid="closed-nft-notice" className="mx-auto -mt-4 mb-6 max-w-[260px] text-center">
      <p className="text-[11px] font-medium text-[var(--text)]">{NFT_MENU_COPY.closedTitle}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">{NFT_MENU_COPY.closedBody}</p>
      <button
        type="button"
        data-testid="closed-nft-unwrap"
        disabled={loading}
        onClick={() =>
          void burn().then((sig) => {
            if (sig) setBurnedPda(nftPdaAddress);
          })
        }
        className="mt-2 min-h-[44px] border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 text-[11px] font-semibold text-[var(--accent)] disabled:opacity-40 md:min-h-0 md:py-1.5"
      >
        {loading ? "Unwrapping…" : NFT_MENU_COPY.unwrap}
      </button>
      {error && (
        <p data-testid="closed-nft-error" className="mt-1 text-[10px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};
