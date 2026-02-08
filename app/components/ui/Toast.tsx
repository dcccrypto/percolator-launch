"use client";

import { FC, useEffect, useState } from "react";
import { useToastContext, type ToastItem } from "@/hooks/useToast";

const COLORS: Record<ToastItem["type"], { bg: string; border: string; icon: string }> = {
  success: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", icon: "✓" },
  error: { bg: "bg-red-500/10", border: "border-red-500/30", icon: "✕" },
  info: { bg: "bg-blue-500/10", border: "border-blue-500/30", icon: "ℹ" },
  warning: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", icon: "⚠" },
};

const TEXT_COLORS: Record<ToastItem["type"], string> = {
  success: "text-emerald-400",
  error: "text-red-400",
  info: "text-blue-400",
  warning: "text-yellow-400",
};

const SingleToast: FC<{ item: ToastItem; onDismiss: (id: string) => void }> = ({
  item,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(item.id), 300);
    }, 5000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const c = COLORS[item.type];

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm transition-all duration-300 ${c.bg} ${c.border} ${
        visible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"
      }`}
    >
      <span className={`text-base font-bold ${TEXT_COLORS[item.type]}`}>{c.icon}</span>
      <span className="text-sm text-slate-200">{item.message}</span>
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(() => onDismiss(item.id), 300);
        }}
        className="ml-2 text-slate-500 hover:text-slate-300"
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
