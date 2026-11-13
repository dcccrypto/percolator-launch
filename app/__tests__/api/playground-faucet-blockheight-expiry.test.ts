// @vitest-environment node
/**
 * GH#2598 — the Playground USDC faucet must not bind post-broadcast
 * confirmation to lastValidBlockHeight on the load-balanced devnet RPC.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROUTE = path.resolve(__dirname, '../../app/api/playground/faucet/route.ts');
const SERVER_RPC = path.resolve(__dirname, '../../lib/server-rpc.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function usdcMintSection(src: string): string {
  const start = src.indexOf('// ── Mint Sim-USDC');
  const end = src.indexOf('// ── Small SOL airdrop');

  expect(start, 'USDC mint section marker moved or disappeared').toBeGreaterThanOrEqual(0);
  expect(end, 'SOL airdrop marker moved or disappeared').toBeGreaterThan(start);

  return src.slice(start, end);
}

describe('GH#2598: playground faucet blockheight-expiry regression', () => {
  it('uses shared signature-status confirmation instead of blockheight-bound confirmTransaction', () => {
    const route = read(ROUTE);
    const section = usdcMintSection(route);

    expect(route).toMatch(
      /confirmServerSignature[\s\S]*getServerConnection[\s\S]*ServerSignatureExecutionError[\s\S]*ServerSignatureTimeoutError[\s\S]*from\s*['"]@\/lib\/server-rpc['"]/,
    );
    expect(section).toMatch(/getLatestBlockhash\(\s*['"]finalized['"]\s*\)/);
    expect(section).not.toMatch(/getLatestBlockhash\(\s*['"]confirmed['"]\s*\)/);
    expect(section).not.toContain('lastValidBlockHeight');
    expect(section).not.toContain('confirmTransaction(');
    expect(section).toMatch(
      /confirmServerSignature\(\s*connection,\s*usdcSig,\s*\{\s*timeoutMs:\s*45_000\s*\}\s*\)/,
    );
  });

  it('does not broaden the fix into unrelated faucet broadcast-policy changes', () => {
    const section = usdcMintSection(read(ROUTE));

    expect(section).toContain('sendRawTransaction(');
    expect(section).toMatch(/skipPreflight:\s*false/);
    expect(section).not.toMatch(/maxRetries\s*:/);
  });

  it('releases a claim only for pre-broadcast or explicitly established execution failure', () => {
    const section = usdcMintSection(read(ROUTE));

    expect(section).toContain(
      'const wasBroadcast = typeof usdcSig === "string" && usdcSig.length > 0',
    );
    expect(section).toContain(
      'mintErr instanceof ServerSignatureExecutionError',
    );
    expect(section).toContain(
      'const unresolved = wasBroadcast && !definiteFailure',
    );
    expect(section).toContain('recordClaim(walletAddress)');
    expect(section).toContain('pending: true');
    expect(section).toContain('retryable: false');
    expect(section).toContain('usdc_sig: usdcSig');

    expect(section).toMatch(
      /if\s*\(unresolved\)[\s\S]*recordClaim\(walletAddress\)[\s\S]*else if\s*\(supabase && gate\.claimId\)[\s\S]*releaseFaucetClaim/,
    );
  });

  it('the shared helper bounds status RPCs, reports final on-chain errors, never broadcasts, and the existing server sender delegates to it', () => {
    const helper = read(SERVER_RPC);

    const statusHelperStart = helper.indexOf(
      'async function getSignatureStatusWithTimeout(',
    );
    const confirmStart = helper.indexOf(
      'export async function confirmServerSignature(',
    );
    const senderStart = helper.indexOf(
      'export async function sendAndConfirmServerTx(',
    );

    expect(
      statusHelperStart,
      'getSignatureStatusWithTimeout() missing',
    ).toBeGreaterThanOrEqual(0);
    expect(confirmStart, 'confirmServerSignature() missing').toBeGreaterThan(
      statusHelperStart,
    );
    expect(
      senderStart,
      'sendAndConfirmServerTx() missing or appears before confirmServerSignature()',
    ).toBeGreaterThan(confirmStart);

    const confirmationSection = helper.slice(statusHelperStart, senderStart);

    expect(confirmationSection).toContain('getSignatureStatus(');
    expect(confirmationSection).toContain('searchTransactionHistory: true');
    expect(confirmationSection).toContain('Promise.race([');
    expect(helper).toContain('STATUS_REQUEST_TIMEOUT_MS = 5_000');
    expect(helper).toContain('FINAL_STATUS_TIMEOUT_MS = 2_000');
    expect(confirmationSection).toContain('status?.err');
    expect(confirmationSection).toContain('ServerSignatureExecutionError');
    expect(confirmationSection).toContain('ServerSignatureTimeoutError');
    expect(confirmationSection).not.toContain('sendRawTransaction(');

    expect(helper).toContain(
      'return confirmServerSignature(connection, sig, { timeoutMs });',
    );
  });
});
