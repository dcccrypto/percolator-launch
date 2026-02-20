"use client";

import { FC, ReactNode, useState } from "react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { AccessibleWalletModal } from "./AccessibleWalletModal";

/**
 * Drop-in replacement for @solana/wallet-adapter-react-ui's WalletModalProvider.
 *
 * Provides the same WalletModalContext (so useWalletModal() and
 * WalletMultiButton still work) but renders our AccessibleWalletModal
 * instead of the library's default, which has several ARIA issues:
 *
 * - Missing id on the title element (aria-labelledby broken)
 * - Close button without aria-label
 * - Missing aria-expanded / aria-controls on collapse toggle
 * - No focus management (no initial focus, no focus restoration)
 *
 * See: https://github.com/dcccrypto/percolator-launch/issues/248
 */
export const AccessibleWalletModalProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <WalletModalContext.Provider value={{ visible, setVisible }}>
      {children}
      {visible && <AccessibleWalletModal />}
    </WalletModalContext.Provider>
  );
};
