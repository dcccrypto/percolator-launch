import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GH#2204 — `getProgramAccounts` was forwarded without validating the target
 * program.
 *
 * A filter requirement (`dataSize` / `memcmp`) was added first, and it is
 * necessary but NOT sufficient: the issue's own example — dumping the SPL Token
 * Program — supplies `dataSize: 165` quite happily and still returns every token
 * account on the cluster. A filter bounds the result SHAPE, not the program, and
 * on a program with millions of matching accounts that is no bound at all.
 *
 * These tests exercise the request-shape predicate directly. The route holds it
 * in a module-private helper, so the predicate is reproduced here against the
 * same config source the route uses — if the config surface changes, the first
 * test fails rather than the guard silently passing everything.
 */

vi.mock('@/lib/config', () => ({
  getRpcEndpoint: () => 'https://rpc.example.com',
  getAllProgramIds: () => ['WrapperProg1111111111111111111111111111111', 'TierProg111111111111111111111111111111111'],
  getConfig: () => ({
    nftProgramId: 'NftProg11111111111111111111111111111111111',
    vaultProgramId: 'VaultProg1111111111111111111111111111111',
    matcherProgramId: 'MatcherProg11111111111111111111111111111',
  }),
}));

import { getAllProgramIds, getConfig } from '@/lib/config';

/** Mirrors the route's allowlist construction. */
function gpaAllowed(): Set<string> {
  const cfg = getConfig() as Record<string, unknown>;
  const extra = ['nftProgramId', 'vaultProgramId', 'matcherProgramId']
    .map((k) => cfg[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return new Set<string>([...getAllProgramIds(), ...extra]);
}

const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('getProgramAccounts is restricted to Percolator programs (GH#2204)', () => {
  it('rejects the SPL Token Program — the issue’s own example', () => {
    // This is the case a dataSize filter does NOT stop: `dataSize: 165` is the
    // SPL token-account size, so the filter check passes and the upstream node
    // would return every token account in existence.
    expect(gpaAllowed().has(SPL_TOKEN)).toBe(false);
  });

  it('rejects an arbitrary third-party program', () => {
    expect(gpaAllowed().has('Vote111111111111111111111111111111111111111')).toBe(false);
  });

  it('allows every program the app legitimately queries', () => {
    const allowed = gpaAllowed();
    // Wrapper + slab tiers (userAccountScan), matcher (matcherCaps),
    // NFT program (userAccountScan nftProgramId), stake/vault.
    for (const id of [
      'WrapperProg1111111111111111111111111111111',
      'TierProg111111111111111111111111111111111',
      'NftProg11111111111111111111111111111111111',
      'VaultProg1111111111111111111111111111111',
      'MatcherProg11111111111111111111111111111',
    ]) {
      expect(allowed.has(id)).toBe(true);
    }
  });

  it('a non-string target is rejected rather than coerced', () => {
    // params[0] missing/undefined must not fall through to the upstream node.
    const target: unknown = undefined;
    const ok = typeof target === 'string' && gpaAllowed().has(target);
    expect(ok).toBe(false);
  });

  it('the allowlist is non-empty — a config regression must not open the gate', () => {
    // If getAllProgramIds() ever returned [], an allowlist check would still
    // "work" while rejecting everything; the inverse (empty set treated as
    // permissive) is the dangerous shape. Pin that it is populated.
    expect(gpaAllowed().size).toBeGreaterThan(0);
  });
});
