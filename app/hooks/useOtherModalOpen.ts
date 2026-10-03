import { useEffect, useState, type RefObject } from "react";

/**
 * True while any modal dialog (`[aria-modal="true"]`) other than `ownRef`'s is
 * showing anywhere in the document.
 *
 * Used by fixed chrome that is portaled to <body> (the mobile Trade band) so it
 * can step aside while a dialog is up. Several trade-page dialogs still render
 * inline inside the layout's `z-[1]` page wrapper (Add Margin, the oracle
 * details panel), so their own z-50/z-[60] is capped at 1 in
 * the root stacking context and a root-level z-40 band would paint over their
 * buttons. Watching the DOM covers every dialog — inline, portaled, or from a
 * third-party wallet modal — without each one having to opt in.
 *
 * A dialog counts as hidden when it, or an ancestor, is `inert` or `hidden`
 * (the closed mobile order sheet stays mounted but `inert`).
 */
export function isOtherModalOpen(own: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll('[aria-modal="true"]');
  for (const el of Array.from(dialogs)) {
    if (own && (own === el || own.contains(el))) continue;
    if (el.closest("[inert], [hidden]")) continue;
    return true;
  }
  return false;
}

/**
 * True when a touch target sits inside `own` or inside any modal dialog. The
 * order sheet's iOS touchmove guard uses this so a dialog opened on top of the
 * sheet (portaled to <body>, outside the sheet's subtree) can still scroll.
 */
export function isInsideModalSurface(target: EventTarget | null, own: Element | null): boolean {
  if (!(target instanceof Node)) return false;
  if (own && own.contains(target)) return true;
  const el = target instanceof Element ? target : target.parentElement;
  return !!el?.closest('[aria-modal="true"]');
}

export function useOtherModalOpen(ownRef?: RefObject<Element | null>): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const check = () => setOpen(isOtherModalOpen(ownRef?.current ?? null));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal", "inert", "hidden"],
    });
    return () => observer.disconnect();
  }, [ownRef]);

  return open;
}
