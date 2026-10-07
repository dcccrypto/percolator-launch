"use client";

import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { FC, ReactNode } from "react";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { ToastProvider } from "@/hooks/useToast";
import { ToastContainer } from "@/components/ui/Toast";
import { LotExpLoaderBridge } from "@/components/v22/LotExpLoaderBridge";
import { ResumeKeeperRegistrations } from "@/components/create/ResumeKeeperRegistrations";

export const Providers: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <WalletProvider>
      <ToastProvider>
        {children}
        <ToastContainer />
        <ResumeKeeperRegistrations />
        <LotExpLoaderBridge />
      </ToastProvider>
    </WalletProvider>
  );
};
