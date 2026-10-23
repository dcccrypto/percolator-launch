/**
 * Audit #12: "Create Trading Account" used to call initUser(min(wallet, 500 USDC)), so the click
 * also deposited an amount the card never named. #2424 made the starter deposit user-chosen; the
 * button now creates the account only, and the card's deposit form (prefilled, editable) moves
 * the money. Harness copied from DepositWithdrawCard.more-funds.test.tsx.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DepositWithdrawCard } from '@/components/trade/DepositWithdrawCard';
import { invalidateWalletBalance } from '@/lib/wallet-balance-invalidation';

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

vi.mock('@/hooks/useWithdraw', () => ({
  useWithdraw: () => ({
    withdraw: vi.fn(),
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
  DevnetTokenFaucetButton: () => <button>faucet</button>,
}));

describe('DepositWithdrawCard: Create Trading Account moves no money', () => {
  const walletA = new PublicKey('11111111111111111111111111111111');
  const walletB = new PublicKey('So11111111111111111111111111111111111111112');
  const collateralMint = new PublicKey('SysvarRent111111111111111111111111111111111');

  const connection = {
    getTokenAccountBalance: mocks.getTokenAccountBalance,
  };

  let activeWallet = walletA;

  beforeEach(() => {
    vi.clearAllMocks();

    activeWallet = walletA;

    mocks.useWalletCompat.mockImplementation(() => ({
      connected: true,
      publicKey: activeWallet,
    }));

    mocks.useConnectionCompat.mockReturnValue({
      connection,
    });

    mocks.getAssociatedTokenAddressSync.mockReturnValue(collateralMint);

    mocks.useUserAccount.mockReturnValue(null);

    mocks.useSlabState.mockReturnValue({
      config: {
        collateralMint,
      },
      params: null,
    });

    mocks.useTokenMeta.mockReturnValue({
      symbol: 'USDC',
      decimals: 6,
    });

    mocks.deposit.mockResolvedValue('deposit-signature');

    mocks.initUser.mockResolvedValue({
      sig: 'test-signature',
    });
  });

  const balance = (raw: string) => mocks.getTokenAccountBalance.mockResolvedValue({ value: { amount: raw, decimals: 6 } });
  const fresh = { idx: 0, pubkey: walletA, account: { capital: 0n, positionSize: 0n, entryPrice: 0n, pnl: 0n } };
  const amountInput = () => screen.getByTestId('deposit-amount-input') as HTMLInputElement;

  it('creates the account with no deposit and says a deposit comes next', async () => {
    balance('5000000');
    render(<DepositWithdrawCard slabAddress="test-slab" />);
    const btn = await screen.findByRole('button', { name: 'Create Trading Account' });
    expect(screen.getByText('Create your trading account on this market, then deposit to trade.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(btn); });
    expect(mocks.initUser).toHaveBeenCalledTimes(1);
    expect(mocks.initUser).toHaveBeenCalledWith(0n);
    expect(mocks.deposit).not.toHaveBeenCalled();
  });

  it('then the deposit form shows the starter amount and deposits what the user chose', async () => {
    balance('5000000');
    const view = render(<DepositWithdrawCard slabAddress="test-slab" />);
    const create = await screen.findByRole('button', { name: 'Create Trading Account' });
    await act(async () => { fireEvent.click(create); });
    mocks.useUserAccount.mockReturnValue(fresh);
    view.rerender(<DepositWithdrawCard slabAddress="test-slab" />);
    await waitFor(() => expect(amountInput().value).toBe('5'));
    expect(mocks.deposit).not.toHaveBeenCalled();
    fireEvent.change(amountInput(), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByTestId('deposit-submit')); });
    expect(mocks.deposit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.deposit.mock.calls[0], (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toContain('3000000');
  });

  it('caps the suggested amount at 500', async () => {
    balance('2000000000');
    mocks.useUserAccount.mockReturnValue(fresh);
    render(<DepositWithdrawCard slabAddress="test-slab" />);
    await waitFor(() => expect(amountInput().value).toBe('500'));
  });

  it('an empty wallet funded from the faucet still gets the suggested amount', async () => {
    balance('0');
    const view = render(<DepositWithdrawCard slabAddress="test-slab" />);
    await waitFor(() => expect(mocks.getTokenAccountBalance).toHaveBeenCalled());
    balance('10000000');
    await act(async () => { invalidateWalletBalance(); });
    await screen.findByRole('button', { name: 'Create Trading Account' });
    mocks.useUserAccount.mockReturnValue(fresh);
    view.rerender(<DepositWithdrawCard slabAddress="test-slab" />);
    await waitFor(() => expect(amountInput().value).toBe('10'));
  });
});
