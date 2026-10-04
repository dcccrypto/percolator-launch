"use client";

import { createContext, useContext, useState, ReactNode } from "react";

interface UsdToggleContextValue {
  showUsd: boolean;
  setShowUsd: (show: boolean) => void;
}

const UsdToggleContext = createContext<UsdToggleContextValue | null>(null);

export function UsdToggleProvider({ children }: { children: ReactNode }) {
  // USD by default: nothing in the app flips this toggle, and with false the analytics cards
  // showed open interest as a bare base-token amount while the other cards showed USD.
  const [showUsd, setShowUsd] = useState(true);

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
