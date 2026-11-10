// @vitest-environment node
/**
 * LOW (review of #3784): the claim-marker address was derived only from public inputs (wallet, UTC day, public
 * faucet authority), so anyone could pre-fund a victim's marker and turn their claim into "already claimed".
 * The seed is now HMAC-SHA256 under a server-side key.
 */
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import nacl from 'tweetnacl';

const signerRef = vi.hoisted(() => ({ current: null as null | { signMessage: (m: Uint8Array) => Uint8Array } }));
vi.mock('@/lib/devnet-signer', () => ({ getDevnetMintSigner: () => signerRef.current }));

import { claimMarkerSeed, markerAddresses, resolveMarkerKey } from '@/lib/sim-usdc-claim-guard';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const W1 = Keypair.generate().publicKey.toBase58();
const W2 = Keypair.generate().publicKey.toBase58();
const AUTH = Keypair.generate().publicKey;
const DAY = 20_000;

/** The pre-fix public derivation, inlined so this test does not depend on the code under test. */
const legacySeed = (w: string, d: number) =>
  createHash('sha256').update(`percolator-sim-usdc-claim|${w}|${d}`).digest('hex').slice(0, 32);

describe('keyed claim-marker seed', () => {
  it('is deterministic per (wallet, day, key)', async () => {
    const [a] = await markerAddresses(AUTH, W1, [DAY], KEY_A);
    const [b] = await markerAddresses(AUTH, W1, [DAY], KEY_A);
    expect(a.seed).toBe(b.seed);
    expect(a.address.equals(b.address)).toBe(true);
  });

  it('differs across wallets and days', async () => {
    const [a] = await markerAddresses(AUTH, W1, [DAY], KEY_A);
    const [w] = await markerAddresses(AUTH, W2, [DAY], KEY_A);
    const [d] = await markerAddresses(AUTH, W1, [DAY + 1], KEY_A);
    expect(a.address.equals(w.address)).toBe(false);
    expect(a.address.equals(d.address)).toBe(false);
  });

  it('is not the old public derivation (seed or address)', async () => {
    const [a] = await markerAddresses(AUTH, W1, [DAY], KEY_A);
    expect(a.seed).not.toBe(legacySeed(W1, DAY));
    const legacyAddr = await PublicKey.createWithSeed(AUTH, legacySeed(W1, DAY), SystemProgram.programId);
    expect(a.address.equals(legacyAddr)).toBe(false);
  });

  it('cannot be computed without the key: a different key gives a different address', async () => {
    const [a] = await markerAddresses(AUTH, W1, [DAY], KEY_A);
    const [b] = await markerAddresses(AUTH, W1, [DAY], KEY_B);
    expect(a.seed).not.toBe(b.seed);
    expect(a.address.equals(b.address)).toBe(false);
  });

  it('seed fits createAccountWithSeed (<= 32 bytes) and is URL-safe ASCII', () => {
    for (let d = DAY; d < DAY + 50; d++) {
      const s = claimMarkerSeed(W1, d, KEY_A);
      expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(32);
      expect(s).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });
});

describe('resolveMarkerKey', () => {
  it('prefers SIM_USDC_MARKER_KEY and changes with it', () => {
    const k1 = resolveMarkerKey({ SIM_USDC_MARKER_KEY: 'a'.repeat(32) } as NodeJS.ProcessEnv);
    const k2 = resolveMarkerKey({ SIM_USDC_MARKER_KEY: 'b'.repeat(32) } as NodeJS.ProcessEnv);
    expect(k1.equals(k2)).toBe(false);
    expect(k1.equals(resolveMarkerKey({ SIM_USDC_MARKER_KEY: 'a'.repeat(32) } as NodeJS.ProcessEnv))).toBe(true);
  });

  it('falls back to a stable key derived from the sealed signer, distinct per authority', () => {
    const kpA = nacl.sign.keyPair();
    const kpB = nacl.sign.keyPair();
    signerRef.current = { signMessage: (m) => nacl.sign.detached(m, kpA.secretKey) };
    const a1 = resolveMarkerKey({} as NodeJS.ProcessEnv);
    const a2 = resolveMarkerKey({} as NodeJS.ProcessEnv);
    signerRef.current = { signMessage: (m) => nacl.sign.detached(m, kpB.secretKey) };
    const b = resolveMarkerKey({} as NodeJS.ProcessEnv);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });

  it('fails closed (no public fallback) when no key material exists, and ignores too-short env keys', () => {
    signerRef.current = null;
    expect(() => resolveMarkerKey({} as NodeJS.ProcessEnv)).toThrow(/marker key unavailable/);
    expect(() => resolveMarkerKey({ SIM_USDC_MARKER_KEY: 'short' } as NodeJS.ProcessEnv)).toThrow(/marker key unavailable/);
  });
});
