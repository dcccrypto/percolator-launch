"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Network } from "./config";

const NetworkContext = createContext<Network>("devnet");

export function NetworkProvider({ value, children }: { value: Network; children: ReactNode }) {
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): Network {
  return useContext(NetworkContext);
}
