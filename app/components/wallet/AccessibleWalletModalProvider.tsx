"use client";

/**
 * Provider stub — Privy handles the modal internally.
 * Kept for import compatibility with existing code.
 */

import { FC, ReactNode } from "react";

export const AccessibleWalletModalProvider: FC<{ children: ReactNode }> = ({ children }) => {
  return <>{children}</>;
};
