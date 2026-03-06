"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Network } from "./config";

// Default fail-closed to mainnet — consistent with getNetwork() in config.ts.
const NetworkContext = createContext<Network>("mainnet");

export function NetworkProvider({ value, children }: { value: Network; children: ReactNode }) {
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): Network {
  return useContext(NetworkContext);
}
