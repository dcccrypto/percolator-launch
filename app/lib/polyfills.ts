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

// BigInt JSON serialization — prevents "Do not know how to serialize BigInt" crashes
// Safe: only adds toJSON if not already defined
if (typeof BigInt !== "undefined" && !(BigInt.prototype as unknown as Record<string, unknown>).toJSON) {
  (BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
    return this.toString();
  };
}

export {};
