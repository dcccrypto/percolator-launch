"use client";

import { createContext, useContext, useState, ReactNode } from "react";

interface UsdToggleContextValue {
  showUsd: boolean;
  setShowUsd: (show: boolean) => void;
}

const UsdToggleContext = createContext<UsdToggleContextValue | null>(null);

export function UsdToggleProvider({ children }: { children: ReactNode }) {
  const [showUsd, setShowUsd] = useState(false);

  return (
    <UsdToggleContext.Provider value={{ showUsd, setShowUsd }}>
      {children}
    </UsdToggleContext.Provider>
  );
}

export function useUsdToggle() {
  const ctx = useContext(UsdToggleContext);
  if (!ctx) throw new Error("useUsdToggle must be used within UsdToggleProvider");
  return ctx;
}
