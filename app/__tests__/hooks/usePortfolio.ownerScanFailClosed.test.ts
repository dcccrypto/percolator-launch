import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceCandidates = [
  resolve(process.cwd(), 'hooks/usePortfolio.ts'),
  resolve(process.cwd(), 'app/hooks/usePortfolio.ts'),
];

const sourcePath = sourceCandidates.find((candidate) => existsSync(candidate));

if (!sourcePath) {
  throw new Error(`Unable to locate hooks/usePortfolio.ts from cwd: ${process.cwd()}`);
}

const source = readFileSync(sourcePath, 'utf8');

function getSection(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  expect(start, `Missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `Missing end marker: ${endMarker}`).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe('usePortfolio owner-scan fail-closed regression', () => {
  it('does not convert an owner-scan RPC rejection into an empty result', () => {
    const ownerScan = getSection(
      'v17 owner-scan: ONE getProgramAccounts',
      'NFT-wrapped position recovery (v17)',
    );

    expect(ownerScan).toContain('connection.getProgramAccounts(programId');

    expect(ownerScan).not.toMatch(
      /\.catch\(\(\)\s*=>\s*\[\]\s+as\s+Awaited<ReturnType<typeof connection\.getProgramAccounts>>\)/,
    );
  });

  it('rethrows owner-scan failures before NFT recovery can publish partial data', () => {
    const ownerScan = getSection(
      'v17 owner-scan: ONE getProgramAccounts',
      'NFT-wrapped position recovery (v17)',
    );

    // The last catch in this section is the aggregate owner-scan catch.
    const catchStart = ownerScan.lastIndexOf('} catch (error) {');

    expect(catchStart).toBeGreaterThanOrEqual(0);

    const catchBlock = ownerScan.slice(catchStart);
    const logIndex = catchBlock.indexOf('[usePortfolio] v17 owner-scan failed:');
    const throwIndex = catchBlock.indexOf('throw error;');
    expect(logIndex).toBeGreaterThanOrEqual(0);
    expect(throwIndex).toBeGreaterThan(logIndex);
  });

  it('writes the shared cache only after a successful portfolio fetch', () => {
    const sharedLoader = getSection(
      'function loadPortfolioShared(',
      'export function usePortfolio',
    );

    const fetchIndex = sharedLoader.indexOf('const p = fetcher()');
    const thenIndex = sharedLoader.indexOf('.then((snapshot) => {', fetchIndex);
    const cacheWriteIndex = sharedLoader.indexOf('portfolioSnapshotCache.set', thenIndex);
    const finallyIndex = sharedLoader.indexOf('.finally', cacheWriteIndex);

    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(thenIndex).toBeGreaterThan(fetchIndex);
    expect(cacheWriteIndex).toBeGreaterThan(thenIndex);
    expect(finallyIndex).toBeGreaterThan(cacheWriteIndex);
  });
});
