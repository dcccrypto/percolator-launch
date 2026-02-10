"use client";

import { FC, useEffect, useRef } from "react";
import gsap from "gsap";
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
      gsap.fromTo(
        el,
        { opacity: 0, scale: 0.95, x: 40 },
        { opacity: 1, scale: 1, x: 0, duration: 0.5, ease: "elastic.out(1, 0.5)" }
      );
    }

    const timer = setTimeout(() => {
      if (!prefersReduced && el) {
        gsap.to(el, {
          opacity: 0,
          x: 40,
          scale: 0.95,
          duration: 0.3,
          ease: "power2.in",
          onComplete: () => onDismiss(item.id),
        });
      } else {
        onDismiss(item.id);
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [item.id, onDismiss, prefersReduced]);

  const c = COLORS[item.type];

  const handleDismiss = () => {
    const el = elRef.current;
    if (!prefersReduced && el) {
      gsap.to(el, {
        opacity: 0,
        x: 40,
        scale: 0.95,
        duration: 0.3,
        ease: "power2.in",
        onComplete: () => onDismiss(item.id),
      });
    } else {
      onDismiss(item.id);
    }
  };

  return (
    <div
      ref={elRef}
      className={`pointer-events-auto flex items-center gap-3 rounded-sm border px-4 py-3 shadow-lg bg-[var(--panel-bg)] ${c.border}`}
      style={{ opacity: 0 }}
    >
      <span className={`text-base font-bold ${TEXT_COLORS[item.type]}`}>{c.icon}</span>
      <span className="text-sm text-[var(--text)]">{item.message}</span>
      <button
        onClick={handleDismiss}
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
    <div className="pointer-events-none fixed right-4 top-20 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <SingleToast key={t.id} item={t} onDismiss={dismiss} />
      ))}
    </div>
  );
};
