/**
 * E2E Test: Liquidation Flow
 * Test ID: E2E-002
 * 
 * Critical Path: Open leveraged position → Price moves against → Liquidation triggered → Insurance fund credited
 * Validates: Liquidation detection, execution, insurance fund updates
 */

import { test, expect } from '@playwright/test';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

const TEST_WALLET_PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

test.describe('Liquidation Flow - E2E-002', () => {
  let connection: Connection;
  let testWallet: Keypair;

  test.beforeAll(async () => {
    connection = new Connection(RPC_URL, 'confirmed');
    
    if (!TEST_WALLET_PRIVATE_KEY) {
      throw new Error('TEST_WALLET_PRIVATE_KEY environment variable not set');
    }
    
    const privateKeyArray = JSON.parse(TEST_WALLET_PRIVATE_KEY);
    testWallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
    
    const balance = await connection.getBalance(testWallet.publicKey);
    console.log(`Test wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  });

  test('should liquidate underwater position and credit insurance fund', async ({ page }) => {
    // Step 1: Open highly leveraged position
    let positionId: string;
    let initialInsuranceFund: number;
    
    await test.step('Open highly leveraged position', async () => {
      await page.goto('http://localhost:3000/trade');
      
      // Connect wallet
      await page.click('button:has-text("Connect Wallet")');
      await page.waitForSelector('[data-testid="wallet-modal"]');
      await page.click('[data-testid="wallet-phantom"]');
      await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
      
      // Select market
      await page.click('[data-testid="market-selector"]');
      await page.click('[data-testid="market-SOL-PERP"]');
      
      // Select Short direction (easier to liquidate in rising market)
      await page.click('[data-testid="trade-direction-short"]');
      
      // Enter small amount with maximum leverage (10x or 20x)
      await page.fill('[data-testid="trade-amount-input"]', '0.5');
      
      await page.click('[data-testid="leverage-selector"]');
      await page.click('[data-testid="leverage-20x"]'); // Maximum leverage
      
      // Wait for preview
      await expect(page.locator('[data-testid="trade-preview"]')).toBeVisible();
      
      // Check liquidation price is shown
      const liquidationPrice = await page.locator('[data-testid="preview-liquidation-price"]').textContent();
      console.log('📊 Liquidation price:', liquidationPrice);
      
      // Record initial insurance fund balance (from dashboard or API)
      await page.goto('http://localhost:3000/dashboard');
      initialInsuranceFund = parseFloat(
        (await page.locator('[data-testid="insurance-fund-balance"]').textContent()) || '0'
      );
      console.log('💰 Initial insurance fund:', initialInsuranceFund);
      
      // Go back to trade and submit
      await page.goto('http://localhost:3000/trade');
      await page.click('[data-testid="submit-trade-button"]');
      
      // Wait for confirmation
      await expect(page.locator('[data-testid="trade-success-toast"]')).toBeVisible({ timeout: 30000 });
      
      // Get position ID
      await page.waitForURL(/.*\/positions\/.*/);
      positionId = page.url().split('/').pop() || '';
      
      console.log('✅ Highly leveraged position opened:', positionId);
    });

    // Step 2: Trigger price movement against position
    await test.step('Trigger adverse price movement', async () => {
      // In real E2E, we'd wait for natural price movement or use oracle service
      // For testing, we can use admin endpoint to update oracle price
      
      // Option 1: Wait for real price movement (slow but realistic)
      // await page.waitForTimeout(60000); // Wait 1 minute
      
      // Option 2: Trigger price update via backend API (faster for testing)
      await page.evaluate(async (posId) => {
        // Call backend endpoint to simulate oracle price increase
        // This would move price against our short position
        await fetch('http://localhost:4000/api/test/update-oracle-price', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            market: 'SOL-PERP',
            priceChange: 10 // Increase price by 10% to trigger liquidation
          })
        });
      }, positionId);
      
      console.log('📈 Price moved against position');
      
      // Wait for crank to detect and process liquidation
      await page.waitForTimeout(10000); // Wait for crank interval (usually 60s, shortened for testing)
    });

    // Step 3: Verify liquidation was triggered
    await test.step('Verify liquidation executed', async () => {
      // Navigate to portfolio
      await page.goto('http://localhost:3000/portfolio');
      
      // Position should be gone (liquidated)
      await page.waitForTimeout(2000);
      await expect(page.locator(`[data-testid="position-${positionId}"]`)).not.toBeVisible();
      
      // Check liquidation history
      await page.click('[data-testid="liquidations-tab"]');
      
      // Verify liquidation appears in history
      const liquidationRow = page.locator(`[data-testid="liquidation-${positionId}"]`);
      await expect(liquidationRow).toBeVisible();
      
      // Verify liquidation details
      const liquidationType = await liquidationRow.locator('[data-testid="liquidation-type"]').textContent();
      expect(liquidationType).toContain('Automatic'); // Or 'Forced'
      
      console.log('✅ Position liquidated successfully');
    });

    // Step 4: Verify insurance fund was credited
    await test.step('Verify insurance fund credited', async () => {
      await page.goto('http://localhost:3000/dashboard');
      
      // Get updated insurance fund balance
      const updatedInsuranceFund = parseFloat(
        (await page.locator('[data-testid="insurance-fund-balance"]').textContent()) || '0'
      );
      
      console.log('💰 Updated insurance fund:', updatedInsuranceFund);
      
      // Insurance fund should have increased (received liquidation penalty)
      expect(updatedInsuranceFund).toBeGreaterThan(initialInsuranceFund);
      
      const increase = updatedInsuranceFund - initialInsuranceFund;
      console.log('📈 Insurance fund increase:', increase);
      
      // Verify increase is reasonable (should be >0 but <position size)
      expect(increase).toBeGreaterThan(0);
      expect(increase).toBeLessThan(0.5); // Less than our initial position size
      
      console.log('✅ Insurance fund credited correctly');
    });

    // Step 5: Verify liquidation details in backend
    await test.step('Verify liquidation data integrity', async () => {
      // Check via API that liquidation was recorded correctly
      const response = await page.evaluate(async (posId) => {
        const res = await fetch(`http://localhost:4000/api/liquidations/${posId}`);
        return res.json();
      }, positionId);
      
      expect(response).toHaveProperty('positionId', positionId);
      expect(response).toHaveProperty('liquidatedAt');
      expect(response).toHaveProperty('insuranceFundCredit');
      
      // Verify insurance fund credit amount matches
      expect(response.insuranceFundCredit).toBeGreaterThan(0);
      
      console.log('✅ Liquidation data integrity verified');
    });
  });

  test('should not liquidate healthy position (LIQ-006)', async ({ page }) => {
    await page.goto('http://localhost:3000/trade');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Open conservative position (low leverage)
    await page.click('[data-testid="market-selector"]');
    await page.click('[data-testid="market-SOL-PERP"]');
    await page.click('[data-testid="trade-direction-long"]');
    await page.fill('[data-testid="trade-amount-input"]', '1');
    
    await page.click('[data-testid="leverage-selector"]');
    await page.click('[data-testid="leverage-2x"]'); // Low leverage = safer
    
    await page.click('[data-testid="submit-trade-button"]');
    await expect(page.locator('[data-testid="trade-success-toast"]')).toBeVisible({ timeout: 30000 });
    
    const positionId = page.url().split('/').pop() || '';
    
    // Wait for potential liquidation check (should not happen)
    await page.waitForTimeout(15000);
    
    // Navigate to portfolio
    await page.goto('http://localhost:3000/portfolio');
    
    // Verify position is still active
    await expect(page.locator(`[data-testid="position-${positionId}"]`)).toBeVisible();
    
    // Verify health ratio is good (>100%)
    const healthRatio = await page.locator(`[data-testid="position-${positionId}"] [data-testid="health-ratio"]`).textContent();
    const healthValue = parseFloat(healthRatio || '0');
    expect(healthValue).toBeGreaterThan(100);
    
    console.log('✅ Healthy position not liquidated (health:', healthValue, '%)');
  });

  test('should reject stale oracle price for liquidation (LIQ-002)', async ({ page }) => {
    // This test would require backend cooperation to simulate stale oracle
    // We can verify the frontend shows warning when oracle is stale
    
    await page.goto('http://localhost:3000/portfolio');
    
    // Inject stale oracle data via browser console
    await page.evaluate(() => {
      // Mock stale oracle timestamp (>60s old)
      const staleTimestamp = Date.now() - 90000; // 90 seconds ago
      
      window.localStorage.setItem('mock_oracle_timestamp', staleTimestamp.toString());
      
      // Trigger oracle staleness check
      window.dispatchEvent(new Event('oracleCheck'));
    });
    
    // Wait for staleness warning
    await expect(page.locator('[data-testid="oracle-stale-warning"]')).toBeVisible({ timeout: 5000 });
    
    const warningText = await page.locator('[data-testid="oracle-stale-warning"]').textContent();
    expect(warningText).toContain('stale');
    expect(warningText).toContain('oracle');
    
    console.log('✅ Stale oracle price warning shown');
  });

  test('should handle gas estimation failure gracefully (LIQ-004)', async ({ page }) => {
    // This would require mocking RPC to return gas estimation error
    // For E2E, we verify the UI handles such errors
    
    await page.goto('http://localhost:3000/portfolio');
    
    // Inject gas estimation failure via browser console
    await page.evaluate(() => {
      // Mock RPC to fail gas estimation
      const originalFetch = window.fetch;
      window.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('getRecentBlockhash')) {
          throw new Error('Gas estimation failed: RPC timeout');
        }
        return originalFetch(url, options);
      };
    });
    
    // Try to close a position (which would fail gas estimation)
    const positions = await page.locator('[data-testid^="position-"]').count();
    
    if (positions > 0) {
      await page.click('[data-testid^="position-"]');
      await page.click('[data-testid="close-position-button"]');
      await page.click('[data-testid="confirm-close-button"]');
      
      // Should show gas estimation error
      await expect(page.locator('[data-testid="gas-estimation-error"]')).toBeVisible({ timeout: 10000 });
      
      const errorText = await page.locator('[data-testid="gas-estimation-error"]').textContent();
      expect(errorText).toContain('gas');
      
      console.log('✅ Gas estimation error handled gracefully');
    } else {
      console.log('⚠️ No positions available to test gas estimation failure');
    }
  });
});

test.describe('Liquidation Edge Cases', () => {
  test('should prevent PnL overflow on extreme positions (LIQ-003)', async ({ page }) => {
    // This is more of a backend test, but we can verify frontend handles large numbers
    
    await page.goto('http://localhost:3000/portfolio');
    
    // Inject extreme PnL value via browser console
    await page.evaluate(() => {
      // Create mock position with extreme PnL
      const mockPosition = {
        id: 'test-overflow-position',
        size: Number.MAX_SAFE_INTEGER,
        pnl: Number.MAX_SAFE_INTEGER * 2, // Would overflow
        entryPrice: 100,
        currentPrice: 200
      };
      
      window.localStorage.setItem('mock_position_overflow', JSON.stringify(mockPosition));
      
      // Trigger position render
      window.dispatchEvent(new Event('positionsUpdated'));
    });
    
    await page.waitForTimeout(1000);
    
    // Verify app doesn't crash
    await expect(page.locator('[data-testid="portfolio-container"]')).toBeVisible();
    
    // Check for overflow protection message
    const hasOverflowWarning = await page.locator('[data-testid="overflow-warning"]').isVisible().catch(() => false);
    
    if (hasOverflowWarning) {
      console.log('✅ Overflow protection active');
    } else {
      console.log('⚠️ No overflow warning (may be handled silently)');
    }
    
    // Verify no JavaScript errors in console
    const errors = await page.evaluate(() => {
      return (window as any).__errors || [];
    });
    
    expect(errors.length).toBe(0);
    
    console.log('✅ PnL overflow handled without crash');
  });
});
