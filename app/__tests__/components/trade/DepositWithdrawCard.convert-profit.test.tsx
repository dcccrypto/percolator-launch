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


describe('DepositWithdrawCard: realized profit is withdrawable', () => {
  const wallet = new PublicKey('3pae8qvc8wimpETqPkxYTYMciUiRNJ5Mpu8gGvBWqLxZ');
  const portfolio = new PublicKey('4yjoGo9NWMv8XCfV2CZgaP6RyjwxxV6XbvMzmR7Z8b3i');
  const collateralMint = new PublicKey('DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC');
  const account = { capital: 49_975_111n, pnl: 222_882n, positionSize: 0n, entryPrice: 0n };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useWalletCompat.mockReturnValue({ connected: true, publicKey: wallet });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: mocks.getTokenAccountBalance } });
    mocks.getTokenAccountBalance.mockResolvedValue({ value: { amount: '0', decimals: 6 } });
    mocks.getAssociatedTokenAddressSync.mockReturnValue(collateralMint);
    mocks.useUserAccount.mockReturnValue({ idx: 0, account, pubkey: portfolio });
    mocks.useSlabState.mockReturnValue({ config: { collateralMint }, params: null });
    mocks.useTokenMeta.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    mocks.withdraw.mockResolvedValue('withdraw-signature');
  });

  it('shows capital + convertible profit and Max withdraws all of it', async () => {
    mocks.useConvertibleProfit.mockReturnValue({ status: 'ready', postCapital: 50_197_993n, convertible: 222_882n, prefix: [] });
    render(<DepositWithdrawCard slabAddress="8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx" initialMode="withdraw" />);
    expect(screen.getByTestId('account-balance').textContent).toContain('50.197');
    fireEvent.click(screen.getByText('Max'));
    expect((screen.getByTestId('withdraw-amount-input') as HTMLInputElement).value).toBe('50.197993');
    await act(async () => { fireEvent.click(screen.getByTestId('withdraw-submit')); });
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({ amount: 50_197_993n, portfolioPk: portfolio }));
    expect(mocks.useConvertibleProfit).toHaveBeenCalledWith(expect.any(String), portfolio, 49_975_111n, 222_882n, false);
  });

  it('NEGATIVE CONTROL: with nothing convertible the balance and Max stay at capital', () => {
    mocks.useConvertibleProfit.mockReturnValue({ status: 'none' });
    render(<DepositWithdrawCard slabAddress="8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx" initialMode="withdraw" />);
    expect(screen.getByTestId('account-balance').textContent).toContain('49.975');
    fireEvent.click(screen.getByText('Max'));
    expect((screen.getByTestId('withdraw-amount-input') as HTMLInputElement).value).toBe('49.975111');
    fireEvent.change(screen.getByTestId('withdraw-amount-input'), { target: { value: '50.1' } });
    expect(screen.getByTestId('withdraw-submit').textContent).toBe('Insufficient capital');
  });

  it('profit not backed yet: one calm line, capital still withdrawable', () => {
    mocks.useConvertibleProfit.mockReturnValue({ status: 'settling', released: 222_882n, code: 21 });
    render(<DepositWithdrawCard slabAddress="8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx" initialMode="withdraw" />);
    expect(screen.getByTestId('settling-profit').textContent).toMatch(/^Your profit becomes withdrawable once the other side of your trade settles/);
    expect(screen.getByTestId('account-balance').textContent).toContain('49.975');
  });
});

describe('DepositWithdrawCard: withdraw with an open position', () => {
  const wallet = new PublicKey('3pae8qvc8wimpETqPkxYTYMciUiRNJ5Mpu8gGvBWqLxZ');
  const portfolio = new PublicKey('4yjoGo9NWMv8XCfV2CZgaP6RyjwxxV6XbvMzmR7Z8b3i');
  const collateralMint = new PublicKey('DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC');
  // 0.1 long at $150 against ~50 USDC: plenty of capital above initial margin, which the
  // old free-margin Max offered even though useWithdraw refuses any withdrawal here.
  const account = { capital: 49_975_111n, pnl: 0n, positionSize: 100_000n, entryPrice: 150_000_000n };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useWalletCompat.mockReturnValue({ connected: true, publicKey: wallet });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: mocks.getTokenAccountBalance } });
    mocks.getTokenAccountBalance.mockResolvedValue({ value: { amount: '0', decimals: 6 } });
    mocks.getAssociatedTokenAddressSync.mockReturnValue(collateralMint);
    mocks.useUserAccount.mockReturnValue({ idx: 0, account, pubkey: portfolio });
    mocks.useSlabState.mockReturnValue({ config: { collateralMint }, params: null });
    mocks.useTokenMeta.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    mocks.useConvertibleProfit.mockReturnValue({ status: 'none' });
  });

  it('offers no Max, says to close first, and never sends a withdrawal', async () => {
    render(<DepositWithdrawCard slabAddress="8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx" initialMode="withdraw" />);
    expect(screen.queryByText('Max')).toBeNull();
    expect(screen.getByTestId('withdraw-position-open').textContent).toBe('Close your position to withdraw.');
    expect(screen.queryByText(/may trigger liquidation/)).toBeNull();
    fireEvent.change(screen.getByTestId('withdraw-amount-input'), { target: { value: '1' } });
    const submit = screen.getByTestId('withdraw-submit') as HTMLButtonElement;
    expect(submit.textContent).toBe('Close your position to withdraw');
    expect(submit.disabled).toBe(true);
    await act(async () => { fireEvent.click(submit); });
    expect(mocks.withdraw).not.toHaveBeenCalled();
    // The balance still shows what the account holds.
    expect(screen.getByTestId('account-balance').textContent).toContain('49.975');
  });
});
