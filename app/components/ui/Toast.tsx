"use client";

import { FC, useEffect, useRef } from "react";
import { withGsap } from "@/lib/gsap-lazy";
import { useToastContext, type ToastItem } from "@/hooks/useToast";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const COLORS: Record<ToastItem["type"], { bg: string; border: string; icon: string }> = {
  success: { bg: "bg-[var(--long)]/10", border: "border-[var(--long)]/30", icon: "\u2713" },
  error: { bg: "bg-[var(--short)]/10", border: "border-[var(--short)]/30", icon: "\u2715" },
  info: { bg: "bg-[var(--accent)]/10", border: "border-[var(--accent)]/30", icon: "\u2139" },
  warning: { bg: "bg-[var(--warning)]/10", border: "border-[var(--warning)]/30", icon: "\u26A0" },
};

const TEXT_COLORS: Record<ToastItem["type"], string> = {
  success: "text-[var(--long)]",
  error: "text-[var(--short)]",
  info: "text-[var(--accent)]",
  warning: "text-[var(--warning)]",
};

/**
 * UX WP-10 (audit §4.9, UI-1): success 4 s, info / warning 6 s, error sticky until dismissed.
 */
export const TOAST_DURATION_MS: Record<ToastItem["type"], number | null> = { success: 4_000, info: 6_000, warning: 6_000, error: null };

const SingleToast: FC<{ item: ToastItem; onDismiss: (id: string) => void }> = ({
  item,
  onDismiss,
}) => {
  const elRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    if (prefersReduced) {
      el.style.opacity = "1";
      el.style.transform = "none";
    } else {
      // Fast slide/fade — a trading terminal needs toasts to feel snappy, not
      // bouncy. Previously a 500ms elastic overshoot; that reads as sluggish
      // against sub-second price ticks elsewhere in the UI.
      withGsap(
        (gsap) => {
          gsap.fromTo(
            el,
            { opacity: 0, x: 40 },
            { opacity: 1, x: 0, duration: 0.18, ease: "power2.out" }
          );
        },
        () => {
          el.style.opacity = "1";
          el.style.transform = "none";
        },
      );
    }

    const duration = TOAST_DURATION_MS[item.type];
    if (duration === null) return;
    const timer = setTimeout(() => {
      if (!prefersReduced && el) {
        withGsap(
          (gsap) => {
            gsap.to(el, {
              opacity: 0,
              x: 40,
              duration: 0.15,
              ease: "power2.in",
              onComplete: () => onDismiss(item.id),
            });
          },
          () => onDismiss(item.id),
        );
      } else {
        onDismiss(item.id);
      }
    }, duration);

    return () => clearTimeout(timer);
  }, [item.id, item.type, onDismiss, prefersReduced]);

  const c = COLORS[item.type];

  const handleDismiss = () => {
    const el = elRef.current;
    if (!prefersReduced && el) {
      withGsap(
        (gsap) => {
          gsap.to(el, {
            opacity: 0,
            x: 40,
            duration: 0.15,
            ease: "power2.in",
            onComplete: () => onDismiss(item.id),
          });
        },
        () => onDismiss(item.id),
      );
    } else {
      onDismiss(item.id);
    }
  };

  return (
    <div
      ref={elRef}
      data-testid="toast"
      data-type={item.type}
      role={item.type === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex items-center gap-3 rounded-sm border px-4 py-3 shadow-lg bg-[var(--panel-bg)] ${c.border}`}
      style={{ opacity: 0 }}
    >
      <span className={`text-sm font-bold ${TEXT_COLORS[item.type]}`}>{c.icon}</span>
      <span className="text-sm text-[var(--text)]">{item.message}</span>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="ml-2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        ✕
      </button>
    </div>
  );
};

export const ToastContainer: FC = () => {
  const { toasts, dismiss } = useToastContext();

  return (
    // Top-right on desktop, top-center on mobile (clear of the bottom nav); announced politely.
    <div
      data-testid="toast-container"
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed left-1/2 top-16 z-[100] flex w-[calc(100%-32px)] max-w-sm -translate-x-1/2 flex-col gap-2 md:left-auto md:right-4 md:top-20 md:w-auto md:translate-x-0"
    >
      {toasts.map((t) => (
        <SingleToast key={t.id} item={t} onDismiss={dismiss} />
      ))}
    </div>
  );
};
