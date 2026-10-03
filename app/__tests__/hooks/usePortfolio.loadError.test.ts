/**
 * usePortfolio swallowed a failed scan, so a wallet whose first scan failed (directory 5xx,
 * RPC 429) read as a confirmed-empty account. `error` is set only when nothing has loaded yet.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';

// Each test uses its own wallet so the shared snapshot cache never seeds one test from another.
let pk = new PublicKey(new Uint8Array(32).fill(7));
const connection = { getProgramAccounts: vi.fn(), getMultipleAccountsInfo: vi.fn().mockResolvedValue([]) };
vi.mock('@/hooks/useWalletCompat', () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({ publicKey: pk, connected: true }),
}));
vi.mock('@/lib/config', async (orig) => ({ ...(await orig<any>()), getAllProgramIds: () => [], getNetwork: () => 'devnet' }));
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

import { usePortfolio } from '@/hooks/usePortfolio';

const fail = () => connection.getProgramAccounts.mockRejectedValue(new Error('429'));
const ok = () => connection.getProgramAccounts.mockResolvedValue([]);

describe('usePortfolio load error', () => {
  let seed = 10;
  beforeEach(() => { pk = new PublicKey(new Uint8Array(32).fill(seed++)); });

  it('flags a failed first scan instead of reporting an empty account', async () => {
    fail();
    const { result } = renderHook(() => usePortfolio());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.positions).toEqual([]);
    expect(result.current.error).toBeTruthy();
  });

  it('a successful retry clears the error', async () => {
    fail();
    const { result } = renderHook(() => usePortfolio());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    ok();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('a failed retry keeps the error until a scan succeeds', async () => {
    fail();
    const { result } = renderHook(() => usePortfolio());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    const calls = connection.getProgramAccounts.mock.calls.length;
    act(() => result.current.refresh());
    await waitFor(() => expect(connection.getProgramAccounts.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.error).toBeTruthy();
  });

  it('a failed background refresh after a good load stays silent', async () => {
    ok();
    const { result } = renderHook(() => usePortfolio());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error ?? null).toBeNull();
    const calls = connection.getProgramAccounts.mock.calls.length;
    fail();
    act(() => result.current.refresh());
    await waitFor(() => expect(connection.getProgramAccounts.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.error ?? null).toBeNull();
  });
});
