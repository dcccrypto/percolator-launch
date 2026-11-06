/**
 * Test-only: lift a RECORDED v2.2 portfolio (wrapper VERSION 19, engine discriminator 19, 10,603 B, captured on devnet
 * before engine #299) to the rc23 layout (engine discriminator 20, 10,607 B): insert the 4-byte `loss_provenance`
 * (`LOSS_PROVENANCE_NONE` = 0, what the engine writes at init) right after the resolved-payout receipt (account byte
 * 10,475 = 16 + the old engine length 10,459) and stamp discriminator 20 at byte 114. Every offset below 10,475 is
 * unchanged by #299; the wrapper trailer (matcher config, id, sequence, expiry) moves +4 with it. Anything that is not
 * such a portfolio (markets, ledgers, v2.1 portfolios, already-lifted bytes) is returned as is.
 * Same helper as percolator-sdk#437 test/helpers/portfolio-disc20.ts.
 */
export const OLD_V22_PORTFOLIO_LEN = 10_603;
export const LOSS_PROVENANCE_OFF = 10_475;
export const PROVENANCE_DISCRIMINATOR_OFF = 114;

export function liftV22Portfolio(b: Uint8Array): Uint8Array {
  if (b.length !== OLD_V22_PORTFOLIO_LEN || b[10] !== 2) return b;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(8, true) !== 19 || dv.getUint16(PROVENANCE_DISCRIMINATOR_OFF, true) !== 19) return b;
  const out = new Uint8Array(b.length + 4);
  out.set(b.subarray(0, LOSS_PROVENANCE_OFF), 0);
  out.set(b.subarray(LOSS_PROVENANCE_OFF), LOSS_PROVENANCE_OFF + 4);
  new DataView(out.buffer).setUint16(PROVENANCE_DISCRIMINATOR_OFF, 20, true);
  return out;
}

/** base64 -> bytes, lifting a recorded pre-#299 v2.2 portfolio (see {@link liftV22Portfolio}). */
export const b64Lifted = (s: string): Uint8Array => liftV22Portfolio(new Uint8Array(Buffer.from(s, "base64")));
