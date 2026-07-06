import { useEffect } from "react";

/**
 * Locks background page scroll while a modal/overlay is mounted, restoring the
 * previous value on unmount. Extracts the inline pattern `MobileOrderSheet`
 * (app/trade/[slab]/page.tsx) already uses so every portaled trade-page dialog
 * behaves the same way — without this, wheel/trackpad scrolling over a modal's
 * dim backdrop scrolls the trade page underneath it.
 *
 * Deliberately simple (save + restore, no ref-count): the trade page never
 * stacks two of these dialogs at once, so nested locks aren't a concern here.
 */
export function useLockBodyScroll(): void {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
}
