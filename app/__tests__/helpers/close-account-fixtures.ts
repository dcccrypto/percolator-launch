/**
 * Real portfolio bytes (v2.1: DAC2a44p, 9,563 B; v2.2: QA's flat CHILLHOUSE winner, 10,603 B) edited into the
 * states the ClosePortfolio emptiness rule distinguishes. Offsets are the wrapper's: body @116, capital +32,
 * pnl +48, reserved pnl +64, fee credits +192, cancel-deposit escrow +208, active bitmap +232.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import fixtureV22 from "../fixtures/v22-flat-winner-portfolio-2026-10-11.json";
import { LAYOUT_V21, LAYOUT_V22 } from "@/lib/v22/sdk/layout";

export const V21_BYTES = Buffer.from(
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "DAC2a44p.portfolio.json"), "utf8")).dataBase64,
  "base64",
);
export const V22_BYTES = Buffer.from(fixtureV22.b64, "base64");

const BODY = 116;
export const OFF = { capital: BODY + 32, pnl: BODY + 48, reserved: BODY + 64, fee: BODY + 192, escrow: BODY + 208, bitmap: BODY + 232 } as const;

export type Fx = "v21" | "v22";
export const layoutFor = (fx: Fx) => (fx === "v21" ? LAYOUT_V21 : LAYOUT_V22).portfolio;
export const base = (fx: Fx): Buffer => Buffer.from(fx === "v21" ? V21_BYTES : V22_BYTES);

export const walletOf = (d: Uint8Array): PublicKey => new PublicKey(d.subarray(BODY, BODY + 32));
export const marketOf = (d: Uint8Array): PublicKey => new PublicKey(d.subarray(16, 48));

export function setU128(d: Buffer, off: number, v: bigint): Buffer {
  d.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
  d.writeBigUInt64LE(v >> 64n, off + 8);
  return d;
}

/** The empty state: no capital, pnl, fees, escrow, legs, source claims, locks, close progress or receipt. */
export function emptied(fx: Fx): Buffer {
  const d = base(fx);
  for (const k of ["capital", "pnl", "reserved", "fee", "escrow"] as const) d.fill(0, OFF[k], OFF[k] + 16);
  d.fill(0, OFF.bitmap, OFF.bitmap + 8);
  const P = layoutFor(fx);
  for (let i = 0; i < P.legCount; i++) d[P.legsOff + i * P.legStride + P.leg.active] = 0;
  d.fill(0, P.sourceDomainsOff, P.sourceDomainsOff + P.sourceDomainCap * P.sourceDomainStride);
  const locks = P.sourceDomainsOff + P.sourceDomainCap * P.sourceDomainStride + 121;
  d.fill(0, locks, P.resolvedPayoutReceiptOff + 66); // locks + close progress + receipt
  d[P.matcherConfigOff + 96] &= 0xfe; // not the LP (control bit 0 = matcher enabled)
  return d;
}

export const lockOff = (fx: Fx): number => {
  const P = layoutFor(fx);
  return P.sourceDomainsOff + P.sourceDomainCap * P.sourceDomainStride + 121;
};
export const closeProgressOff = (fx: Fx): number => lockOff(fx) + 4;
export const receiptOff = (fx: Fx): number => layoutFor(fx).resolvedPayoutReceiptOff;
