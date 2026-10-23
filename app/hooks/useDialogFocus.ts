"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * A dialog's keyboard focus (lifted from the shared Modal, GH#2286): on mount it moves focus into
 * `ref`, Tab / Shift+Tab cycle inside it, and on unmount focus returns to whatever opened it.
 * Without it Tab walks out of the dialog into the page behind the scrim — still live, still
 * clickable, invisible — and closing drops the caret at the top of the document.
 *
 * For dialogs that can't use <Modal> (their own layout / z-tier). `active` is for a dialog that
 * stays mounted and renders nothing while closed: the trap starts each time it turns true.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Deliberately NOT filtered on `offsetParent !== null`. That is the usual
    // visibility idiom and it is wrong here twice over: it is null for every
    // descendant of a `position: fixed` ancestor — which a dialog overlay is — and
    // it is null for everything under jsdom. Either way the list came back empty,
    // the Tab handler hit its `items.length === 0` branch, and the "trap" pinned
    // focus to nothing at all.
    //
    // The selector already excludes disabled controls and tabindex="-1"; `[hidden]`
    // covers the deliberate-hide case without depending on layout.
    //
    // A dialog that renders a desktop and a mobile copy and hides one with CSS (OracleDetailsPanel)
    // would focus the hidden copy: prefer what has a layout box. jsdom gives nothing a box, so then
    // every candidate stays.
    const focusables = () => {
      const all = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("hidden"));
      const shown = all.filter((el) => el.getClientRects().length > 0);
      return shown.length > 0 ? shown : all;
    };
    // preventScroll: a tall dialog (the share card) must open at its top, not scrolled to its first button.
    focusables()[0]?.focus({ preventScroll: true });

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focused = document.activeElement as HTMLElement | null;
      // Focus is in something stacked on top (the wallet's signing dialog while Add Margin waits on
      // a deposit, or another dialog): it owns Tab. The scrim keeps clicks off the page behind, so
      // focus outside this dialog that isn't <body> is never the page itself.
      if (focused && focused !== document.body && !dialog.contains(focused)) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (focused === first || !dialog.contains(focused))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (focused === last || !dialog.contains(focused))) {
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
  }, [active]);
}
