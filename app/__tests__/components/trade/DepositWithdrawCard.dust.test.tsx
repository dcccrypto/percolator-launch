/**
 * ConvertReleasedPnl (tag 28): a flat winner's withdrawable balance is capital + the released
 * profit the program would convert (hooks/useConvertibleProfit), and Max offers all of it.
 * Numbers are the devnet fresh winner 4yjoGo9N: capital 49.975111, pnl 0.222882.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DepositWithdrawCard } from '@/components/trade/DepositWithdrawCard';

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  getTokenAccountBalance: vi.fn(),
  getAssociatedTokenAddressSync: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useTokenMeta: vi.fn(),
  initUser: vi.fn(),
  deposit: vi.fn(),
  useConvertibleProfit: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock('@/hooks/useWalletCompat', () => ({
  useWalletCompat: mocks.useWalletCompat,
  useConnectionCompat: mocks.useConnectionCompat,
}));

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddressSync: mocks.getAssociatedTokenAddressSync,
}));

vi.mock('@/hooks/useUserAccount', () => ({
  useUserAccount: mocks.useUserAccount,
}));

vi.mock('@/hooks/useDeposit', () => ({
  useDeposit: () => ({
    deposit: mocks.deposit,
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useConvertibleProfit', () => ({
  useConvertibleProfit: mocks.useConvertibleProfit,
}));

vi.mock('@/hooks/useWithdraw', () => ({
  useWithdraw: () => ({
    withdraw: mocks.withdraw,
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useInitUser', () => ({
  useInitUser: () => ({
    initUser: mocks.initUser,
    loading: false,
    error: null,
  }),
}));

vi.mock('@/components/providers/SlabProvider', () => ({
  useSlabState: mocks.useSlabState,
}));

vi.mock('@/hooks/useTokenMeta', () => ({
  useTokenMeta: mocks.useTokenMeta,
}));

vi.mock('@/hooks/useLivePrice', () => ({
  useLivePrice: () => ({
    priceE6: null,
  }),
}));

vi.mock('@/lib/mock-mode', () => ({
  isMockMode: () => false,
}));

vi.mock('@/lib/mock-trade-data', () => ({
  isMockSlab: () => false,
  getMockUserAccount: () => null,
}));

vi.mock('@/lib/tx', () => ({
  prewarmTxLanding: vi.fn(),
}));

vi.mock('@/components/trade/DevnetTokenFaucetButton', () => ({
  DevnetTokenFaucetButton: () => null,
}));



describe('QA 12:38: 0.196 USDC of released profit in a flat capital-0 account (swordcat FnY2i6UF…)', () => {
  const wallet = new PublicKey('6Rz2i9cRAQ2JRZ9pZAuPidYQAYhrJSWbbWaJAVvknAVq');
  const portfolio = new PublicKey('FnY2i6UFCwHQYbS8rcA6QzjcgUxwZzYXjHhjDeLM1b68');
  const collateralMint = new PublicKey('DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC');
  const account = { capital: 0n, pnl: 196_157n, positionSize: 0n, entryPrice: 0n };
  const SLAB = '6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useWalletCompat.mockReturnValue({ connected: true, publicKey: wallet });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: mocks.getTokenAccountBalance } });
    mocks.getTokenAccountBalance.mockResolvedValue({ value: { amount: '0', decimals: 6 } });
    mocks.getAssociatedTokenAddressSync.mockReturnValue(collateralMint);
    mocks.useUserAccount.mockReturnValue({ idx: 0, account, pubkey: portfolio });
    mocks.useSlabState.mockReturnValue({ config: { collateralMint }, params: null });
    mocks.useTokenMeta.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    mocks.withdraw.mockResolvedValue('sig');
  });

  it('quote ready: "Withdraw all (0.196 USDC)" is ONE click and withdraws the whole 196,157 (convert + withdraw)', async () => {
    mocks.useConvertibleProfit.mockReturnValue({ status: 'ready', postCapital: 196_157n, convertible: 196_157n, prefix: [] });
    render(<DepositWithdrawCard slabAddress={SLAB} initialMode="withdraw" />);
    const btn = screen.getByTestId('withdraw-all');
    expect(btn.textContent).toBe('Withdraw all (0.196 USDC)');
    await act(async () => { fireEvent.click(btn); });
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({ amount: 196_157n, portfolioPk: portfolio }));
  });

  it('quote still loading: the card says it is checking (never silent), no Withdraw all yet', () => {
    mocks.useConvertibleProfit.mockReturnValue(null);
    render(<DepositWithdrawCard slabAddress={SLAB} initialMode="withdraw" />);
    expect(screen.getByTestId('claim-status').textContent).toMatch(/^Checking how much of your profit can be withdrawn/);
    expect(screen.queryByTestId('withdraw-all')).toBeNull();
  });

  it('nothing convertible: says so', () => {
    mocks.useConvertibleProfit.mockReturnValue({ status: 'none' });
    render(<DepositWithdrawCard slabAddress={SLAB} initialMode="withdraw" />);
    expect(screen.getByTestId('claim-status').textContent).toMatch(/no profit that can be moved/);
    expect(screen.queryByTestId('withdraw-all')).toBeNull();
  });

  it('CONTROL: an account with capital and no profit shows neither the claim line nor the claim button when nothing is withdrawable', () => {
    mocks.useUserAccount.mockReturnValue({ idx: 0, account: { ...account, capital: 5_000_000n, pnl: 0n }, pubkey: portfolio });
    mocks.useConvertibleProfit.mockReturnValue({ status: 'none' });
    render(<DepositWithdrawCard slabAddress={SLAB} initialMode="withdraw" />);
    expect(screen.queryByTestId('claim-status')).toBeNull();
  });
});
