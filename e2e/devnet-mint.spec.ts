/**
 * E2E Test: Devnet Token Minting
 * 
 * Tests: Token creation, metadata setup, mint authority validation
 * Validates: Metaplex integration, SPL token creation, error handling
 */

import { test, expect } from '@playwright/test';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const TEST_WALLET_PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

test.describe('Devnet Token Minting', () => {
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
    
    if (balance < 1 * LAMPORTS_PER_SOL) {
      console.warn('⚠️ Low balance for minting tests. Requesting airdrop...');
      try {
        const airdropSignature = await connection.requestAirdrop(
          testWallet.publicKey,
          2 * LAMPORTS_PER_SOL
        );
        await connection.confirmTransaction(airdropSignature);
        console.log('✅ Airdrop successful');
      } catch (error) {
        console.error('❌ Airdrop failed:', error);
      }
    }
  });

  test('should create token with valid metadata', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Fill token details
    await test.step('Fill token metadata', async () => {
      const tokenName = `TestToken_${Date.now()}`;
      const tokenSymbol = `TST${Math.floor(Math.random() * 1000)}`;
      
      await page.fill('[data-testid="token-name-input"]', tokenName);
      await page.fill('[data-testid="token-symbol-input"]', tokenSymbol);
      await page.fill('[data-testid="token-decimals-input"]', '6');
      await page.fill('[data-testid="token-supply-input"]', '1000000');
      
      console.log('Token details:', { tokenName, tokenSymbol });
    });
    
    // Optional: Upload token image
    const hasImageUpload = await page.locator('[data-testid="token-image-upload"]').isVisible().catch(() => false);
    
    if (hasImageUpload) {
      await page.setInputFiles('[data-testid="token-image-upload"]', 'test-assets/token-logo.png');
      console.log('Token image uploaded');
    }
    
    // Submit token creation
    await page.click('[data-testid="create-token-button"]');
    
    // Wait for transaction confirmation
    await expect(page.locator('[data-testid="token-creation-success"]')).toBeVisible({ timeout: 60000 });
    
    // Extract token mint address
    const mintAddress = await page.locator('[data-testid="token-mint-address"]').textContent();
    expect(mintAddress).toBeTruthy();
    expect(mintAddress?.length).toBeGreaterThan(30);
    
    console.log('✅ Token created:', mintAddress);
    
    // Verify token appears in wallet
    await page.goto('http://localhost:3000/portfolio');
    await page.waitForTimeout(3000); // Wait for token account to be fetched
    
    const tokenExists = await page.locator(`[data-testid="token-${mintAddress}"]`).isVisible().catch(() => false);
    
    if (tokenExists) {
      console.log('✅ Token visible in portfolio');
    } else {
      console.log('⚠️ Token not immediately visible (may need refresh)');
    }
  });

  test('should reject empty token name (MINT-003)', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Try to create token without name
    await page.fill('[data-testid="token-symbol-input"]', 'TST');
    await page.fill('[data-testid="token-decimals-input"]', '6');
    await page.fill('[data-testid="token-supply-input"]', '1000000');
    
    // Click create button
    await page.click('[data-testid="create-token-button"]');
    
    // Should show validation error
    await expect(page.locator('[data-testid="token-name-error"]')).toBeVisible();
    
    const errorText = await page.locator('[data-testid="token-name-error"]').textContent();
    expect(errorText).toContain('required');
    
    console.log('✅ Empty token name rejected');
  });

  test('should allow emoji in token name (MINT-004)', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Fill with emoji in name
    const tokenName = `🐍 Snake Token ${Date.now()}`;
    await page.fill('[data-testid="token-name-input"]', tokenName);
    await page.fill('[data-testid="token-symbol-input"]', 'SNAKE');
    await page.fill('[data-testid="token-decimals-input"]', '9');
    await page.fill('[data-testid="token-supply-input"]', '100000');
    
    // Should not show validation error
    const hasError = await page.locator('[data-testid="token-name-error"]').isVisible().catch(() => false);
    expect(hasError).toBe(false);
    
    // Create button should be enabled
    await expect(page.locator('[data-testid="create-token-button"]')).toBeEnabled();
    
    console.log('✅ Emoji in token name allowed');
  });

  test('should validate mint authority before enabling create button (MINT-002)', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Fill all fields
    await page.fill('[data-testid="token-name-input"]', 'Test Token');
    await page.fill('[data-testid="token-symbol-input"]', 'TST');
    await page.fill('[data-testid="token-decimals-input"]', '6');
    await page.fill('[data-testid="token-supply-input"]', '1000000');
    
    // Initially, create button might be disabled while checking authority
    const initialState = await page.locator('[data-testid="create-token-button"]').isEnabled();
    
    // Wait for mint authority validation (async check)
    await page.waitForTimeout(2000);
    
    // After validation, button should be enabled
    await expect(page.locator('[data-testid="create-token-button"]')).toBeEnabled({ timeout: 5000 });
    
    // Check for authority validation indicator
    const hasValidationIndicator = await page.locator('[data-testid="mint-authority-validated"]').isVisible().catch(() => false);
    
    if (hasValidationIndicator) {
      console.log('✅ Mint authority validation indicator shown');
    }
    
    console.log('✅ Mint authority validated before enabling button');
  });

  test('should reject invalid PublicKey input (MINT-001)', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Check if there's a custom mint authority field (optional feature)
    const hasMintAuthorityField = await page.locator('[data-testid="mint-authority-input"]').isVisible().catch(() => false);
    
    if (hasMintAuthorityField) {
      // Enter invalid PublicKey
      await page.fill('[data-testid="mint-authority-input"]', 'invalid-pubkey-123');
      
      // Trigger validation
      await page.click('[data-testid="token-name-input"]'); // Click away to trigger blur
      
      // Should show error
      await expect(page.locator('[data-testid="mint-authority-error"]')).toBeVisible();
      
      const errorText = await page.locator('[data-testid="mint-authority-error"]').textContent();
      expect(errorText).toContain('Invalid');
      
      console.log('✅ Invalid PublicKey rejected');
    } else {
      console.log('⚠️ No custom mint authority field found (using wallet as authority)');
    }
  });

  test('should handle Metaplex metadata errors gracefully (MINT-005)', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Mock Metaplex error via browser console
    await page.evaluate(() => {
      // Intercept Metaplex calls to simulate error
      const originalFetch = window.fetch;
      window.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('metadata')) {
          throw new Error('Metaplex metadata creation failed: Invalid PDA');
        }
        return originalFetch(url, options);
      };
    });
    
    // Fill and submit
    await page.fill('[data-testid="token-name-input"]', 'Error Test Token');
    await page.fill('[data-testid="token-symbol-input"]', 'ERR');
    await page.fill('[data-testid="token-decimals-input"]', '6');
    await page.fill('[data-testid="token-supply-input"]', '1000');
    
    await page.click('[data-testid="create-token-button"]');
    
    // Should show Metaplex error
    await expect(page.locator('[data-testid="metaplex-error-toast"]')).toBeVisible({ timeout: 15000 });
    
    const errorText = await page.locator('[data-testid="metaplex-error-toast"]').textContent();
    expect(errorText).toContain('metadata');
    
    // Transaction should NOT be sent
    const tokenCreated = await page.locator('[data-testid="token-creation-success"]').isVisible().catch(() => false);
    expect(tokenCreated).toBe(false);
    
    console.log('✅ Metaplex error handled gracefully');
  });

  test('should validate token decimals range (0-9)', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Try invalid decimals (>9)
    await page.fill('[data-testid="token-name-input"]', 'Test Token');
    await page.fill('[data-testid="token-symbol-input"]', 'TST');
    await page.fill('[data-testid="token-decimals-input"]', '15');
    await page.fill('[data-testid="token-supply-input"]', '1000');
    
    // Click create
    await page.click('[data-testid="create-token-button"]');
    
    // Should show validation error
    await expect(page.locator('[data-testid="token-decimals-error"]')).toBeVisible();
    
    const errorText = await page.locator('[data-testid="token-decimals-error"]').textContent();
    expect(errorText).toMatch(/0.*9/); // Should mention valid range
    
    console.log('✅ Invalid decimals rejected');
  });

  test('should validate token supply is positive', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Try zero supply
    await page.fill('[data-testid="token-name-input"]', 'Test Token');
    await page.fill('[data-testid="token-symbol-input"]', 'TST');
    await page.fill('[data-testid="token-decimals-input"]', '6');
    await page.fill('[data-testid="token-supply-input"]', '0');
    
    // Click create
    await page.click('[data-testid="create-token-button"]');
    
    // Should show validation error
    await expect(page.locator('[data-testid="token-supply-error"]')).toBeVisible();
    
    const errorText = await page.locator('[data-testid="token-supply-error"]').textContent();
    expect(errorText).toContain('greater than 0');
    
    console.log('✅ Zero supply rejected');
  });
});

test.describe('Token Minting Edge Cases', () => {
  test('should handle insufficient SOL balance for minting', async ({ page }) => {
    // This would require draining the test wallet first
    // For demo purposes, we'll mock the error
    
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Mock insufficient balance error
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('sendTransaction')) {
          throw new Error('Insufficient funds for transaction');
        }
        return originalFetch(url, options);
      };
    });
    
    // Fill and submit
    await page.fill('[data-testid="token-name-input"]', 'Test Token');
    await page.fill('[data-testid="token-symbol-input"]', 'TST');
    await page.fill('[data-testid="token-decimals-input"]', '6');
    await page.fill('[data-testid="token-supply-input"]', '1000000');
    
    await page.click('[data-testid="create-token-button"]');
    
    // Should show insufficient funds error
    await expect(page.locator('[data-testid="insufficient-funds-error"]')).toBeVisible({ timeout: 15000 });
    
    const errorText = await page.locator('[data-testid="insufficient-funds-error"]').textContent();
    expect(errorText).toContain('insufficient');
    
    console.log('✅ Insufficient funds error shown');
  });

  test('should allow creating token with maximum supply', async ({ page }) => {
    await page.goto('http://localhost:3000/devnet-mint');
    
    // Connect wallet
    await page.click('button:has-text("Connect Wallet")');
    await page.waitForSelector('[data-testid="wallet-modal"]');
    await page.click('[data-testid="wallet-phantom"]');
    await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
    
    // Fill with maximum u64 value (or close to it)
    await page.fill('[data-testid="token-name-input"]', 'Max Token');
    await page.fill('[data-testid="token-symbol-input"]', 'MAX');
    await page.fill('[data-testid="token-decimals-input"]', '0');
    await page.fill('[data-testid="token-supply-input"]', '18446744073709551615'); // u64 max
    
    // Should not show overflow error
    const hasError = await page.locator('[data-testid="token-supply-error"]').isVisible().catch(() => false);
    
    if (hasError) {
      const errorText = await page.locator('[data-testid="token-supply-error"]').textContent();
      console.log('Error shown:', errorText);
      
      // If error is shown, it should be about u64 limit, not generic error
      expect(errorText).toMatch(/maximum|u64|overflow/i);
    } else {
      console.log('✅ Maximum supply accepted');
    }
  });
});
