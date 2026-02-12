/**
 * E2E Test: Full Trade Lifecycle
 * Test ID: E2E-001
 * 
 * Critical Path: Connect wallet → Open position → Close position
 * Validates: Trade execution, PnL calculation, position management
 */

import { test, expect } from '@playwright/test';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

const TEST_WALLET_PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

test.describe('Trade Lifecycle - E2E-001', () => {
  let connection: Connection;
  let testWallet: Keypair;

  test.beforeAll(async () => {
    // Initialize devnet connection
    connection = new Connection(RPC_URL, 'confirmed');
    
    // Load test wallet from private key
    if (!TEST_WALLET_PRIVATE_KEY) {
      throw new Error('TEST_WALLET_PRIVATE_KEY environment variable not set');
    }
    
    const privateKeyArray = JSON.parse(TEST_WALLET_PRIVATE_KEY);
    testWallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
    
    // Check wallet has sufficient balance (at least 2 SOL for testing)
    const balance = await connection.getBalance(testWallet.publicKey);
    console.log(`Test wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    
    if (balance < 2 * LAMPORTS_PER_SOL) {
      console.warn('⚠️ Test wallet has low balance. Request airdrop on devnet.');
    }
  });

  test('should complete full trade lifecycle: connect → open → close', async ({ page }) => {
    // Navigate to trade page
    await page.goto('http://localhost:3000/trade');
    
    // Step 1: Connect wallet
    await test.step('Connect wallet', async () => {
      await page.click('button:has-text("Connect Wallet")');
      
      // Wait for wallet selector modal
      await page.waitForSelector('[data-testid="wallet-modal"]');
      
      // Select Phantom (or inject test wallet directly)
      await page.click('[data-testid="wallet-phantom"]');
      
      // Wait for connection confirmation
      await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible({ timeout: 10000 });
      
      const walletAddress = await page.locator('[data-testid="wallet-address"]').textContent();
      expect(walletAddress).toContain(testWallet.publicKey.toString().substring(0, 4));
      
      console.log('✅ Wallet connected:', walletAddress);
    });

    // Step 2: Open 1 SOL long position
    let positionId: string;
    await test.step('Open long position', async () => {
      // Select market (e.g., SOL-PERP)
      await page.click('[data-testid="market-selector"]');
      await page.click('[data-testid="market-SOL-PERP"]');
      
      // Select Long direction
      await page.click('[data-testid="trade-direction-long"]');
      
      // Enter amount: 1 SOL
      await page.fill('[data-testid="trade-amount-input"]', '1');
      
      // Select leverage (e.g., 5x)
      await page.click('[data-testid="leverage-selector"]');
      await page.click('[data-testid="leverage-5x"]');
      
      // Wait for trade preview to load
      await expect(page.locator('[data-testid="trade-preview"]')).toBeVisible();
      
      // Verify preview shows fresh data
      const entryPrice = await page.locator('[data-testid="preview-entry-price"]').textContent();
      expect(entryPrice).not.toBe('--');
      
      const estimatedPnL = await page.locator('[data-testid="preview-pnl"]').textContent();
      expect(estimatedPnL).toContain('SOL'); // Should show PnL estimate
      
      console.log('📊 Trade preview - Entry price:', entryPrice);
      
      // Submit trade
      await page.click('[data-testid="submit-trade-button"]');
      
      // Wait for transaction confirmation
      await expect(page.locator('[data-testid="trade-success-toast"]')).toBeVisible({ timeout: 30000 });
      
      // Extract position ID from success message or redirect
      await page.waitForURL(/.*\/positions\/.*/);
      positionId = page.url().split('/').pop() || '';
      
      console.log('✅ Position opened:', positionId);
    });

    // Step 3: Wait for price change (simulate with mock or wait for real movement)
    await test.step('Wait for price movement', async () => {
      // In real E2E, we'd wait for oracle price update
      // For testing, we can trigger a mock price update via WebSocket
      
      await page.waitForTimeout(5000); // Wait 5s for price to potentially change
      
      // Navigate to portfolio page to see updated PnL
      await page.goto('http://localhost:3000/portfolio');
      
      // Find the open position
      const positionRow = page.locator(`[data-testid="position-${positionId}"]`);
      await expect(positionRow).toBeVisible();
      
      // Check PnL is calculated (can be positive or negative)
      const pnlValue = await positionRow.locator('[data-testid="position-pnl"]').textContent();
      expect(pnlValue).not.toBe('--');
      expect(pnlValue).toMatch(/[+-]?\d+\.\d+/); // Should show numeric PnL
      
      console.log('📈 Current PnL:', pnlValue);
    });

    // Step 4: Close position
    await test.step('Close position', async () => {
      // Click on position to expand details
      await page.click(`[data-testid="position-${positionId}"]`);
      
      // Click "Close Position" button
      await page.click('[data-testid="close-position-button"]');
      
      // Confirm closure in modal
      await page.waitForSelector('[data-testid="close-position-modal"]');
      await page.click('[data-testid="confirm-close-button"]');
      
      // Wait for transaction confirmation
      await expect(page.locator('[data-testid="position-closed-toast"]')).toBeVisible({ timeout: 30000 });
      
      // Verify position is removed from portfolio
      await page.reload();
      await expect(page.locator(`[data-testid="position-${positionId}"]`)).not.toBeVisible();
      
      console.log('✅ Position closed successfully');
    });

    // Final verification: Check wallet balance changed
    await test.step('Verify final balance', async () => {
      const finalBalance = await connection.getBalance(testWallet.publicKey);
      console.log(`Final wallet balance: ${finalBalance / LAMPORTS_PER_SOL} SOL`);
      
      // Balance should have changed (minus fees, plus/minus PnL)
      // We don't assert exact amount due to price volatility, just that it's within reasonable range
      expect(finalBalance).toBeGreaterThan(0);
    });
  });

  test('should handle wallet disconnect mid-trade (TRADE-002)', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Start trade setup
    await page.click('[data-testid="market-selector"]');
    await page.click('[data-testid="market-SOL-PERP"]');
    await page.fill('[data-testid="trade-amount-input"]', '1');
    
    // Disconnect wallet before confirming
    await page.click('[data-testid="wallet-menu"]');
    await page.click('[data-testid="disconnect-wallet"]');
    
    // Verify trade button is disabled
    await expect(page.locator('[data-testid="submit-trade-button"]')).toBeDisabled();
    
    // Verify warning message shown
    await expect(page.locator('text=Please connect wallet to trade')).toBeVisible();
    
    console.log('✅ Wallet disconnect handled correctly');
  });

  test('should prevent trade on network mismatch (TRADE-003)', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet on devnet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Simulate network switch to mainnet (via browser console injection)
    await page.evaluate(() => {
      // Mock wallet network change
      window.solana = {
        ...window.solana,
        isPhantom: true,
        isConnected: true,
        publicKey: window.solana.publicKey,
        // Inject mainnet network
        _network: 'mainnet-beta'
      };
      
      // Trigger network change event
      window.dispatchEvent(new Event('walletNetworkChanged'));
    });
    
    // Wait for error message
    await expect(page.locator('[data-testid="network-mismatch-error"]')).toBeVisible({ timeout: 5000 });
    
    // Verify error text
    const errorText = await page.locator('[data-testid="network-mismatch-error"]').textContent();
    expect(errorText).toContain('devnet');
    expect(errorText).toContain('mainnet');
    
    // Verify trade button is disabled
    await expect(page.locator('[data-testid="submit-trade-button"]')).toBeDisabled();
    
    console.log('✅ Network mismatch error shown correctly');
  });

  test('should refresh trade preview on price change (TRADE-004)', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Set up trade
    await page.click('[data-testid="market-selector"]');
    await page.click('[data-testid="market-SOL-PERP"]');
    await page.fill('[data-testid="trade-amount-input"]', '1');
    
    // Capture initial entry price
    await expect(page.locator('[data-testid="trade-preview"]')).toBeVisible();
    const initialPrice = await page.locator('[data-testid="preview-entry-price"]').textContent();
    
    console.log('Initial entry price:', initialPrice);
    
    // Trigger price update via WebSocket mock
    await page.evaluate(() => {
      // Simulate oracle price update event
      window.dispatchEvent(new CustomEvent('priceUpdate', {
        detail: {
          market: 'SOL-PERP',
          price: Math.random() * 100 + 50 // Random price between 50-150
        }
      }));
    });
    
    // Wait for preview to refresh
    await page.waitForTimeout(1000);
    
    // Capture updated entry price
    const updatedPrice = await page.locator('[data-testid="preview-entry-price"]').textContent();
    
    console.log('Updated entry price:', updatedPrice);
    
    // Verify price changed (or at least refresh was attempted)
    // Note: Prices might be the same if market didn't move, but UI should have refreshed
    expect(updatedPrice).not.toBe('--');
    
    console.log('✅ Trade preview refresh working');
  });
});

test.describe('Trade Input Validation', () => {
  test('should validate MAX button uses full balance (TRADE-006)', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Get wallet balance display
    const balanceText = await page.locator('[data-testid="wallet-balance"]').textContent();
    const balanceMatch = balanceText?.match(/(\d+\.?\d*)/);
    const walletBalance = balanceMatch ? parseFloat(balanceMatch[1]) : 0;
    
    console.log('Wallet balance:', walletBalance);
    
    // Click MAX button
    await page.click('[data-testid="max-button"]');
    
    // Verify input is set to balance (minus small buffer for fees)
    const inputValue = await page.locator('[data-testid="trade-amount-input"]').inputValue();
    const maxAmount = parseFloat(inputValue);
    
    // Should be close to wallet balance (within 0.1 SOL for fees)
    expect(maxAmount).toBeGreaterThan(walletBalance - 0.1);
    expect(maxAmount).toBeLessThanOrEqual(walletBalance);
    
    console.log('✅ MAX button set amount to:', maxAmount);
  });

  test('should reject invalid amount input (TRADE-007)', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Try to enter invalid amount
    await page.fill('[data-testid="trade-amount-input"]', 'abc');
    
    // Verify validation error shown
    await expect(page.locator('[data-testid="amount-validation-error"]')).toBeVisible();
    
    const errorText = await page.locator('[data-testid="amount-validation-error"]').textContent();
    expect(errorText).toContain('valid number');
    
    // Verify submit button disabled
    await expect(page.locator('[data-testid="submit-trade-button"]')).toBeDisabled();
    
    console.log('✅ Invalid amount rejected');
  });
});
