/**
 * Detects whether TradingView has one of its own popups open (Indicators / Settings / Compare dialogs, the
 * chart-type and interval dropdowns, context menus).
 *
 * Those live INSIDE the widget's iframe, so no z-index on our side can raise our DOM overlays (position /
 * PnL badges) above them. The robust answer is to not draw over the iframe while one is open. The widget API
 * has no "dialog open" event, so this reads the iframe document (same-origin: the library is served from our
 * own origin). TradingView portals every popup into `#overlap-manager-root`, which is empty when none is
 * open; the other selectors cover dialogs/menus rendered outside it.
 */
export const TV_POPUP_SELECTORS: readonly string[] = [
  "#overlap-manager-root > *",
  '[data-name="indicators-dialog"]',
  '[data-dialog-name]',
  '[data-name="popup-menu-container"]',
  '[data-name="menu-inner"]',
  '[role="dialog"]',
  '[role="menu"]',
];

export function tvPopupOpen(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  try {
    return doc.querySelector(TV_POPUP_SELECTORS.join(",")) !== null;
  } catch {
    return false;
  }
}

/** The iframe document inside `container`, or null (not mounted yet / cross-origin). */
export function tvIframeDocument(container: HTMLElement | null | undefined): Document | null {
  try {
    return container?.querySelector("iframe")?.contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls `onChange(open)` whenever the popup state flips. A MutationObserver on the iframe body does the work;
 * a slow poll re-attaches it if the iframe document is replaced and acts as a backstop.
 */
export function watchTvPopups(container: HTMLElement, onChange: (open: boolean) => void): () => void {
  let last: boolean | null = null;
  let observed: Document | null = null;
  let observer: MutationObserver | null = null;
  const check = () => {
    const doc = tvIframeDocument(container);
    if (doc !== observed) {
      observer?.disconnect();
      observer = null;
      observed = doc;
      if (doc?.body && typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(check);
        observer.observe(doc.body, { childList: true, subtree: true });
      }
    }
    const open = tvPopupOpen(doc);
    if (open !== last) {
      last = open;
      onChange(open);
    }
  };
  check();
  const id = setInterval(check, 300);
  return () => {
    clearInterval(id);
    observer?.disconnect();
  };
}
