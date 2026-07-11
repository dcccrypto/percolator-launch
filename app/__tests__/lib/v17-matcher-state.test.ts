import { PublicKey } from '@solana/web3.js';
import { CTX_VAMM_OFFSET, MATCHER_CONTEXT_LEN, V17_PORTFOLIO_ACCOUNT_LEN } from '@percolatorct/sdk';
import { describe, expect, it } from 'vitest';

import {
  inspectV17MatcherContext,
  isEmptyV17PortfolioMatcherConfig,
  readV17PortfolioMatcherConfig,
  V17_PORTFOLIO_MATCHER_CONFIG_LEN,
} from '@/lib/v17-matcher-state';

function publicKey(fill: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(fill));
}

describe('v17 matcher-state helpers', () => {
  it('parses an explicitly disabled portfolio matcher config', () => {
    const data = new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN);

    const config = readV17PortfolioMatcherConfig(data);

    expect(config.enabled).toBe(false);
    expect(config.matcherProgram.equals(PublicKey.default)).toBe(true);
    expect(config.matcherContext.equals(PublicKey.default)).toBe(true);
    expect(config.matcherDelegate.equals(PublicKey.default)).toBe(true);
  });

  it('parses an enabled portfolio matcher config', () => {
    const data = new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN);
    const offset = data.byteLength - V17_PORTFOLIO_MATCHER_CONFIG_LEN;

    const matcherProgram = publicKey(11);
    const matcherContext = publicKey(12);
    const matcherDelegate = publicKey(13);

    data.set(matcherProgram.toBytes(), offset);
    data.set(matcherContext.toBytes(), offset + 32);
    data.set(matcherDelegate.toBytes(), offset + 64);

    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset + 96, 1n, true);

    const config = readV17PortfolioMatcherConfig(data);

    expect(config.enabled).toBe(true);
    expect(config.matcherProgram.equals(matcherProgram)).toBe(true);
    expect(config.matcherContext.equals(matcherContext)).toBe(true);
    expect(config.matcherDelegate.equals(matcherDelegate)).toBe(true);
  });

  it('rejects a non-boolean matcher enabled value', () => {
    const data = new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN);
    const offset = data.byteLength - V17_PORTFOLIO_MATCHER_CONFIG_LEN;

    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset + 96, 2n, true);

    expect(() => readV17PortfolioMatcherConfig(data)).toThrow(/invalid v17 matcher enabled value/i);
  });

  it('classifies a zeroed matcher context as uninitialized', () => {
    const data = new Uint8Array(MATCHER_CONTEXT_LEN);

    expect(inspectV17MatcherContext(data, publicKey(21))).toBe('uninitialized');
  });

  it('classifies a context containing the expected delegate as initialized', () => {
    const data = new Uint8Array(MATCHER_CONTEXT_LEN);
    const delegate = publicKey(22);

    data.set(delegate.toBytes(), CTX_VAMM_OFFSET);

    expect(inspectV17MatcherContext(data, delegate)).toBe('initialized');
  });

  it('rejects a context bound to another delegate', () => {
    const data = new Uint8Array(MATCHER_CONTEXT_LEN);

    data.set(publicKey(23).toBytes(), CTX_VAMM_OFFSET);

    expect(inspectV17MatcherContext(data, publicKey(24))).toBe('invalid');
  });

  it('rejects an undersized matcher context', () => {
    const data = new Uint8Array(MATCHER_CONTEXT_LEN - 1);

    expect(inspectV17MatcherContext(data, publicKey(25))).toBe('invalid');
  });

  it('distinguishes an empty disabled config from a partially committed config', () => {
    const data = new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN);

    const emptyConfig = readV17PortfolioMatcherConfig(data);

    expect(isEmptyV17PortfolioMatcherConfig(emptyConfig)).toBe(true);

    const offset = data.byteLength - V17_PORTFOLIO_MATCHER_CONFIG_LEN;

    data.set(publicKey(31).toBytes(), offset);

    const partialConfig = readV17PortfolioMatcherConfig(data);

    expect(isEmptyV17PortfolioMatcherConfig(partialConfig)).toBe(false);
  });
});
