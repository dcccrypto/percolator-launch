/**
 * Browser polyfills for @solana/web3.js dependencies.
 * Import this at the top of the root layout to ensure Buffer is
 * available globally before any Solana code runs.
 *
 * Fixes:
 * - "can't access property BN, t is undefined" on some browsers —
 *   ensures `window.Buffer` is defined for code that reads it at runtime.
 *
 * NOTE: a runtime Buffer.prototype BigInt shim used to live here, but
 * the actual bug was a misrouted `require('buffer')` in the production
 * webpack build — it resolved to an older internal polyfill missing
 * writeBigUInt64LE. next.config.ts now aliases webpack's `buffer` import
 * to the `buffer@6.0.3` npm package, which has all the Node-12+ BigInt
 * methods on its prototype natively. No runtime patching needed.
 */

import { Buffer } from "buffer";

if (typeof window !== "undefined") {
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
