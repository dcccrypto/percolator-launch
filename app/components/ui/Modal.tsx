"use client";

import { FC, ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useLockBodyScroll } from "@/hooks/useLockBodyScroll";

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
 *   portal · z-tier + scrim · scroll lock · Escape · overlay-click ·
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

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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
  // The Position NFT panel opens from inside the mobile order sheet, whose own
  // document-level Escape handler collapses the sheet. Without this counter one
  // Escape fired BOTH: the dialog closed AND the sheet collapsed underneath it.
  // The sheet's handler stands down while this is > 0.
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

    // Restore focus to whatever opened the modal. Without this, dismissing drops
    // the caret at the top of the document and a keyboard user has to tab back to
    // where they were.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Deliberately NOT filtered on `offsetParent !== null`. That is the usual
    // visibility idiom and it is wrong here twice over: it is null for every
    // descendant of a `position: fixed` ancestor — which this overlay is — and it
    // is null for everything under jsdom. Either way the list came back empty, the
    // Tab handler hit its `items.length === 0` branch, and the "trap" pinned focus
    // to nothing at all. Caught by the tests before it shipped.
    //
    // The selector already excludes disabled controls and tabindex="-1"; `[hidden]`
    // covers the deliberate-hide case without depending on layout.
    const focusables = () =>
      Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("hidden")
      );
    focusables()[0]?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // THE FIX. Without this, Tab walks straight out of the dialog and into the
      // page behind the scrim — which is still scrolled to wherever it was, still
      // has live trade controls, and is invisible under an 80%-opaque overlay. A
      // keyboard user could operate the page they cannot see.
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !modal.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previouslyFocused?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && dismissible) onClose();
  };

  const content = (
    <div
      ref={overlayRef}
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 ${scrimClassName}`}
      onClick={handleOverlayClick}
      style={{ opacity: 0 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={panelClassName}
        style={{ opacity: 0 }}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
};
