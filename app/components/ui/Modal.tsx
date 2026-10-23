"use client";

import { FC, ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useLockBodyScroll } from "@/hooks/useLockBodyScroll";
import { useDialogFocus } from "@/hooks/useDialogFocus";

/**
 * The one portaled modal shell (GH#2286).
 *
 * The six trade modals each hand-rolled their scrim, z-index, portal, scroll lock,
 * Escape handling and entrance animation. By the time this landed the *divergence*
 * the issue described had already been closed piecemeal — every survivor was on
 * `z-[9999] bg-black/80` — so what this collapses is five identical copies, and
 * what it FIXES is the thing that was uniformly missing rather than uniformly
 * inconsistent: **none of them trapped focus**.
 *
 * That is the failure mode of piecemeal convergence. Five copies agreeing with each
 * other looks finished; it just means the gap is in all five.
 *
 * Owns:
 *   portal · z-tier + scrim · scroll lock · scrolling a panel taller than the screen ·
 *   Escape · overlay-click ·
 *   entrance animation (reduced-motion aware) · focus trap + focus restore
 *
 * Callers own their panel's width, borders and content.
 */
export interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /**
   * The COMPLETE class string for the panel. The primitive deliberately imposes
   * none of its own: every modal here has its own width, border, rounding and
   * overflow, and this is a structural refactor that must not change how any of
   * them look. Chrome is shared; appearance stays the caller's.
   */
  panelClassName: string;
  /** id of the element naming this dialog, for `aria-labelledby`. */
  labelledBy?: string;
  /**
   * When false, the scrim click and Escape are ignored. SendPositionNftModal needs
   * this while a transfer is in flight — dismissing mid-signature would leave the
   * user unsure whether the transaction went out.
   */
  dismissible?: boolean;
  /** Extra scrim classes, e.g. FundingExplainerModal's `backdrop-blur-sm`. */
  scrimClassName?: string;
}

export const Modal: FC<ModalProps> = ({
  onClose,
  children,
  panelClassName,
  labelledBy,
  dismissible = true,
  scrimClassName = "",
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  useLockBodyScroll();

  // Keep onClose in a ref so the mount effect never re-runs on parent re-renders.
  // Trade-page parents re-render constantly (countdown ticks, WS price updates) and
  // pass a freshly-allocated inline closure each time; with `onClose` in the deps,
  // every re-render re-fired the entrance animation and the modal blinked while
  // open. This was solved independently in each modal — now in one place.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  // Nested-dialog counter, lifted from ClosePositionModal/TradeConfirmationModal/
  // SendPositionNftModal where three copies of it live.
  //
  // The mobile order sheet (page.tsx MobileOrderSheet) has its own
  // document-level Escape handler that collapses the sheet. Without this counter
  // one Escape fired BOTH: a dialog opened over the sheet closed AND the sheet
  // collapsed underneath it. The sheet's handler stands down while this is > 0.
  useEffect(() => {
    const current = Number(document.body.dataset.percOpenDialogs ?? "0");
    document.body.dataset.percOpenDialogs = String(current + 1);
    return () => {
      const remaining = Number(document.body.dataset.percOpenDialogs ?? "1") - 1;
      if (remaining <= 0) delete document.body.dataset.percOpenDialogs;
      else document.body.dataset.percOpenDialogs = String(remaining);
    };
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    const modal = modalRef.current;
    if (!overlay || !modal) return;

    if (prefersReduced) {
      overlay.style.opacity = "1";
      modal.style.opacity = "1";
      modal.style.transform = "scale(1)";
    } else {
      gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.15, ease: "power2.out" });
      gsap.fromTo(
        modal,
        { opacity: 0, scale: 0.97, y: -4 },
        { opacity: 1, scale: 1, y: 0, duration: 0.2, ease: "power2.out" }
      );
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissibleRef.current) onCloseRef.current();
    };

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced]);

  // Focus into the panel, Tab trapped inside it, focus restored on close. THE FIX of GH#2286:
  // without it Tab walked straight out of the dialog into the live page behind the scrim.
  // Declared after the entrance-animation effect, where this logic used to live: called ahead of
  // gsap.fromTo, the initial focus was lost (Modal-2286.test.tsx "moves focus into the dialog"; it
  // is kept with gsap mocked).
  useDialogFocus(modalRef);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && dismissible) onClose();
  };

  const content = (
    <div
      ref={overlayRef}
      className={`fixed inset-0 z-[9999] flex justify-center overflow-y-auto overscroll-contain bg-black/80 p-4 ${scrimClassName}`}
      onClick={handleOverlayClick}
      style={{ opacity: 0 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`my-auto ${panelClassName}`}
        style={{ opacity: 0 }}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
};
