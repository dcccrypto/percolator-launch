/**
 * Browser polyfills for @solana/web3.js dependencies.
 * Import this at the top of the root layout to ensure BN and Buffer
 * are available globally before any Solana code runs.
 *
 * Fixes: "can't access property BN, t is undefined" error on some browsers.
 */

import { Buffer } from "buffer";

if (typeof window !== "undefined") {
  // Buffer polyfill
  if (!window.Buffer) {
    (window as unknown as Record<string, unknown>).Buffer = Buffer;
  }
}

export {};
