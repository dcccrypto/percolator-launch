"use client";

import { useEffect, type RefObject } from "react";

/**
 * Closes an open dropdown on a mousedown outside `ref` or on Escape. Escape returns focus to the
 * trigger (the first button inside `ref`) when focus was inside the menu, so a keyboard user isn't
 * left on <body>; it doesn't steal focus from elsewhere (e.g. a wallet's own modal).
 */
export function useMenuDismiss(open: boolean, setOpen: (open: boolean) => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const hadFocus = !!ref.current?.contains(document.activeElement);
      setOpen(false);
      if (hadFocus) ref.current?.querySelector<HTMLElement>("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, ref]);
}
