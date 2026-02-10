"use client";

import { createContext, useContext, useCallback, useState, type ReactNode } from "react";
import { createElement } from "react";

export interface ToastItem {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warning";
}

interface ToastContextValue {
  toasts: ToastItem[];
  toast: (message: string, type?: ToastItem["type"]) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = `toast-${++counter}-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  return createElement(
    ToastContext.Provider,
    { value: { toasts, toast, dismiss } },
    children,
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return { toast: ctx.toast, toasts: ctx.toasts };
}

export function useToastContext() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToastContext must be used within ToastProvider");
  return ctx;
}
