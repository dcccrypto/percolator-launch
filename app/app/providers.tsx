"use client";

import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { FC, ReactNode } from "react";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { ToastProvider } from "@/hooks/useToast";
import { ToastContainer } from "@/components/ui/Toast";
import dynamic from "next/dynamic";

// Renders nothing; resumes this device's unfinished market registrations once the page has
// loaded. Loaded after hydration so the keeper-registration client (and the SDK under it)
// is not in every page's first-load bundle.
const ResumeKeeperRegistrations = dynamic(
  () => import("@/components/create/ResumeKeeperRegistrations").then((m) => m.ResumeKeeperRegistrations),
  { ssr: false },
);

export const Providers: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <WalletProvider>
      <ToastProvider>
        {children}
        <ToastContainer />
        <ResumeKeeperRegistrations />
      </ToastProvider>
    </WalletProvider>
  );
};
