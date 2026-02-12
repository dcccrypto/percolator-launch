/**
 * E2E Test: Wallet Connection & Management
 * 
 * Tests: Connect, disconnect, network switching, multi-wallet support
 * Validates: Wallet integration, state management, network validation
 */

import { test, expect } from '@playwright/test';

test.describe('Wallet Connection', () => {
  test('should connect Phantom wallet successfully', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Click connect wallet button
    await page.click('button:has-text("Connect Wallet")');
    
    // Wait for wallet modal
    await expect(page.locator('[data-testid="wallet-modal"]')).toBeVisible();
    
    // Verify multiple wallet options shown
    await expect(page.locator('[data-testid="wallet-phantom"]')).toBeVisible();
    await expect(page.locator('[data-testid="wallet-solflare"]')).toBeVisible();
    
    // Select Phantom
    await page.click('[data-testid="wallet-phantom"]');
    
    // Wait for connection (in test env, this should be mocked or use test wallet)
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible({ timeout: 10000 });
    
    // Verify wallet address is displayed
    const walletAddress = await page.locator('[data-testid="wallet-address"]').textContent();
    expect(walletAddress).toBeTruthy();
    expect(walletAddress?.length).toBeGreaterThan(10);
    
    console.log('✅ Wallet connected:', walletAddress);
    
    // Verify balance is shown
    await expect(page.locator('[data-testid="wallet-balance"]')).toBeVisible();
    
    const balance = await page.locator('[data-testid="wallet-balance"]').textContent();
    expect(balance).toContain('SOL');
    
    console.log('💰 Wallet balance:', balance);
  });

  test('should disconnect wallet successfully', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Connect wallet first
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Open wallet menu
    await page.click('[data-testid="wallet-menu"]');
    
    // Click disconnect
    await page.click('[data-testid="disconnect-wallet"]');
    
    // Verify wallet is disconnected
    await expect(page.locator('[data-testid="wallet-address"]')).not.toBeVisible();
    await expect(page.locator('button:has-text("Connect Wallet")')).toBeVisible();
    
    console.log('✅ Wallet disconnected successfully');
  });

  test('should switch between different wallets', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Connect Phantom first
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    const phantomAddress = await page.locator('[data-testid="wallet-address"]').textContent();
    console.log('Phantom address:', phantomAddress);
    
    // Disconnect
    await page.click('[data-testid="wallet-menu"]');
    await page.click('[data-testid="disconnect-wallet"]');
    
    // Connect Solflare
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-solflare"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    const solflareAddress = await page.locator('[data-testid="wallet-address"]').textContent();
    console.log('Solflare address:', solflareAddress);
    
    // Addresses may be different (depending on test setup)
    expect(solflareAddress).toBeTruthy();
    
    console.log('✅ Wallet switching works');
  });

  test('should persist wallet connection across page refresh', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    const originalAddress = await page.locator('[data-testid="wallet-address"]').textContent();
    
    // Refresh page
    await page.reload();
    
    // Wait for auto-reconnect
    await page.waitForTimeout(2000);
    
    // Verify wallet is still connected
    const reconnectedAddress = await page.locator('[data-testid="wallet-address"]').textContent();
    expect(reconnectedAddress).toBe(originalAddress);
    
    console.log('✅ Wallet persisted across refresh');
  });
});

test.describe('Network Validation', () => {
  test('should detect and warn on network mismatch', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Connect wallet on devnet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Inject network change event (simulate switch to mainnet)
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('walletNetworkChanged', {
        detail: { network: 'mainnet-beta' }
      }));
    });
    
    // Wait for network mismatch warning
    await expect(page.locator('[data-testid="network-mismatch-warning"]')).toBeVisible({ timeout: 5000 });
    
    const warningText = await page.locator('[data-testid="network-mismatch-warning"]').textContent();
    expect(warningText).toContain('network');
    expect(warningText).toContain('devnet');
    
    console.log('✅ Network mismatch detected and warned');
  });

  test('should show current network in UI', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Verify network indicator is shown
    await expect(page.locator('[data-testid="network-indicator"]')).toBeVisible();
    
    const networkText = await page.locator('[data-testid="network-indicator"]').textContent();
    expect(networkText).toContain('devnet'); // Or 'Devnet'
    
    console.log('✅ Network indicator shown:', networkText);
  });

  test('should allow manual network switching', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Open network selector (if available)
    const hasNetworkSelector = await page.locator('[data-testid="network-selector"]').isVisible().catch(() => false);
    
    if (hasNetworkSelector) {
      await page.click('[data-testid="network-selector"]');
      
      // Verify options shown
      await expect(page.locator('[data-testid="network-option-devnet"]')).toBeVisible();
      await expect(page.locator('[data-testid="network-option-mainnet"]')).toBeVisible();
      
      // Select mainnet
      await page.click('[data-testid="network-option-mainnet"]');
      
      // Verify warning about switching to mainnet
      await expect(page.locator('[data-testid="mainnet-warning"]')).toBeVisible();
      
      console.log('✅ Network switching UI works');
    } else {
      console.log('⚠️ No network selector found (may be wallet-controlled only)');
    }
  });
});

test.describe('Wallet Error Handling', () => {
  test('should handle wallet not installed gracefully', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Mock wallet not installed
    await page.evaluate(() => {
      // Remove wallet from window
      delete (window as any).solana;
      delete (window as any).phantom;
    });
    
    // Try to connect
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    
    // Should show error message
    await expect(page.locator('[data-testid="wallet-not-found-error"]')).toBeVisible({ timeout: 5000 });
    
    const errorText = await page.locator('[data-testid="wallet-not-found-error"]').textContent();
    expect(errorText).toContain('Phantom');
    expect(errorText).toContain('install');
    
    console.log('✅ Wallet not installed error shown');
  });

  test('should handle wallet connection rejection', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Mock wallet rejection
    await page.evaluate(() => {
      (window as any).solana = {
        isPhantom: true,
        connect: async () => {
          throw new Error('User rejected the request');
        }
      };
    });
    
    // Try to connect
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    
    // Should show rejection message
    await expect(page.locator('[data-testid="wallet-rejection-error"]')).toBeVisible({ timeout: 5000 });
    
    const errorText = await page.locator('[data-testid="wallet-rejection-error"]').textContent();
    expect(errorText).toContain('rejected');
    
    console.log('✅ Wallet rejection handled gracefully');
  });

  test('should handle wallet timeout gracefully', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Mock wallet timeout
    await page.evaluate(() => {
      (window as any).solana = {
        isPhantom: true,
        connect: async () => {
          // Simulate timeout by never resolving
          return new Promise(() => {});
        }
      };
    });
    
    // Try to connect
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    
    // Wait for timeout error (should appear after ~30s)
    await expect(page.locator('[data-testid="wallet-timeout-error"]')).toBeVisible({ timeout: 35000 });
    
    const errorText = await page.locator('[data-testid="wallet-timeout-error"]').textContent();
    expect(errorText).toContain('timeout');
    
    console.log('✅ Wallet timeout handled gracefully');
  });
});

test.describe('Wallet State Management', () => {
  test('should clear pending transactions on disconnect', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Start a trade (but don't complete)
    await page.click('[data-testid="market-selector"]');
    await page.click('[data-testid="market-SOL-PERP"]');
    await page.fill('[data-testid="trade-amount-input"]', '1');
    await page.click('[data-testid="submit-trade-button"]');
    
    // Immediately disconnect before transaction confirms
    await page.click('[data-testid="wallet-menu"]');
    await page.click('[data-testid="disconnect-wallet"]');
    
    // Verify pending transaction is cancelled
    await expect(page.locator('[data-testid="transaction-cancelled-toast"]')).toBeVisible({ timeout: 5000 });
    
    console.log('✅ Pending transactions cleared on disconnect');
  });

  test('should update balance after transaction', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Get initial balance
    const initialBalance = await page.locator('[data-testid="wallet-balance"]').textContent();
    console.log('Initial balance:', initialBalance);
    
    // Make a trade
    await page.click('[data-testid="market-selector"]');
    await page.click('[data-testid="market-SOL-PERP"]');
    await page.fill('[data-testid="trade-amount-input"]', '0.1');
    await page.click('[data-testid="submit-trade-button"]');
    
    // Wait for transaction confirmation
    await expect(page.locator('[data-testid="trade-success-toast"]')).toBeVisible({ timeout: 30000 });
    
    // Wait for balance to update
    await page.waitForTimeout(3000);
    
    // Get updated balance
    const updatedBalance = await page.locator('[data-testid="wallet-balance"]').textContent();
    console.log('Updated balance:', updatedBalance);
    
    // Balance should have changed (decreased due to trade + fees)
    expect(updatedBalance).not.toBe(initialBalance);
    
    console.log('✅ Balance updated after transaction');
  });
});
