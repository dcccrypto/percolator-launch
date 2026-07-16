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
    deposit: vi.fn(),
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
  DevnetTokenFaucetButton: () => null,
}));

describe('DepositWithdrawCard wallet-scoped balance lifecycle', () => {
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

    mocks.initUser.mockResolvedValue({
      sig: 'test-signature',
    });
  });

  it('withholds wallet A balance and prevents wallet A-derived account creation while wallet B balance is pending', async () => {
    mocks.getTokenAccountBalance
      .mockResolvedValueOnce({
        value: {
          amount: '900000000',
          decimals: 6,
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise<{
            value: {
              amount: string;
              decimals: number;
            };
          }>(() => {}),
      );

    const { rerender } = render(<DepositWithdrawCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText(/^Wallet:/)).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', {
        name: 'Create Trading Account',
      }),
    ).toBeInTheDocument();

    expect(mocks.getTokenAccountBalance).toHaveBeenCalledTimes(1);

    activeWallet = walletB;

    await act(async () => {
      rerender(<DepositWithdrawCard slabAddress="test-slab" />);

      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.getTokenAccountBalance).toHaveBeenCalledTimes(2);
    });

    // Wallet A state must not remain visible or actionable after wallet B
    // becomes active, even while wallet B's balance request is unresolved.
    expect.soft(screen.queryByText(/^Wallet:/)).not.toBeInTheDocument();

    expect
      .soft(
        screen.queryByRole('button', {
          name: 'Create Trading Account',
        }),
      )
      .not.toBeInTheDocument();

    // Confirm that the second balance request belongs to wallet B.
    expect(mocks.getAssociatedTokenAddressSync).toHaveBeenNthCalledWith(2, collateralMint, walletB);

    const staleCreateAccountButton = screen.queryByRole('button', {
      name: 'Create Trading Account',
    });

    // On a fixed implementation the stale button is absent and this block
    // does not execute. On the vulnerable baseline it remains actionable.
    if (staleCreateAccountButton) {
      await act(async () => {
        fireEvent.click(staleCreateAccountButton);
        await Promise.resolve();
      });
    }

    // 500 USDC is the starter-deposit cap. It must never be derived from
    // wallet A after wallet B becomes active but remains unverified.
    expect.soft(mocks.initUser).not.toHaveBeenCalledWith(500_000_000n);
  });

  it('updates to wallet B balance after the replacement request resolves', async () => {
    mocks.getTokenAccountBalance
      .mockResolvedValueOnce({
        value: {
          amount: '900000000',
          decimals: 6,
        },
      })
      .mockResolvedValueOnce({
        value: {
          amount: '25000000',
          decimals: 6,
        },
      });

    const { rerender } = render(<DepositWithdrawCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText(/^Wallet:/)).toHaveTextContent('900');
    });

    expect(mocks.getTokenAccountBalance).toHaveBeenCalledTimes(1);

    activeWallet = walletB;

    await act(async () => {
      rerender(<DepositWithdrawCard slabAddress="test-slab" />);

      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.getTokenAccountBalance).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.getByText(/^Wallet:/)).toHaveTextContent('25');
    });

    expect(mocks.getAssociatedTokenAddressSync).toHaveBeenNthCalledWith(2, collateralMint, walletB);
  });
});
