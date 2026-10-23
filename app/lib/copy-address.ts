import type { ToastItem } from "@/hooks/useToast";

/** Copies a wallet address and says whether it worked: the wallet menus closed silently on Copy. */
export async function copyAddress(address: string, toast: (message: string, type?: ToastItem["type"]) => void): Promise<void> {
  // The Privy menu opens before its wallet has loaded: copying "" is not a success.
  if (!address) {
    toast("Couldn't copy the address", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(address);
    toast("Address copied", "success");
  } catch {
    toast("Couldn't copy the address", "error");
  }
}
