import { useEffect } from "react";

/**
 * Locks background page scroll while a modal/overlay is mounted, restoring the
 * previous values when the last lock releases. Without it, wheel/trackpad
 * scrolling over a modal's backdrop scrolls the page underneath, and a modal
 * with its own scroll area shows a second scrollbar next to the page's.
 *
 * Locks <html> as well as <body>: `globals.css` sets `html { overflow-x: hidden }`,
 * which makes <html> the viewport scroller (its overflow-y computes to `auto`).
 * The browser only uses <body>'s overflow for the viewport when <html>'s is
 * `visible`, so `body { overflow: hidden }` alone locks nothing here (measured in
 * Chrome: the page scrollbar stays and the page still scrolls). MobileOrderSheet
 * (app/trade/[slab]/page.tsx) found the same thing and locks both.
 *
 * `scrollbar-gutter: stable` keeps the page from shifting sideways when its
 * scrollbar disappears. Ref-counted so stacked dialogs closing in any order
 * leave the page unlocked only after the last one.
 */
let locks = 0;
let saved: { body: string; html: string; gutter: string } | null = null;

export function lockPageScroll(): () => void {
  const html = document.documentElement;
  const body = document.body;
  if (locks === 0) {
    saved = { body: body.style.overflow, html: html.style.overflow, gutter: html.style.scrollbarGutter };
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    html.style.scrollbarGutter = "stable";
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks -= 1;
    if (locks === 0 && saved) {
      body.style.overflow = saved.body;
      html.style.overflow = saved.html;
      html.style.scrollbarGutter = saved.gutter;
      saved = null;
    }
  };
}

export function useLockBodyScroll(): void {
  useEffect(() => lockPageScroll(), []);
}
