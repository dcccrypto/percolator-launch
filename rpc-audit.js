import { Connection, PublicKey, Transaction, SystemProgram, Keypair } from '@solana/web3.js';

const RPC_URL = 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Test accounts
const SLAB_1 = '44GTccW2NZbowKtN9g5oFxokXCrrGnVuZ99xxZLWWPTM';
const SLAB_2 = '8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c';
// Using a common devnet token account (USDC mint on devnet)
const TEST_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'; // Devnet USDC
const TEST_WALLET = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'; // Random devnet wallet

async function measureRPC(name, fn) {
  console.log(`\n🧪 Testing: ${name}`);
  console.log('─'.repeat(60));
  const start = Date.now();
  try {
    const result = await fn();
    const latency = Date.now() - start;
    console.log(`✅ SUCCESS (${latency}ms)`);
    console.log('Result:', JSON.stringify(result, null, 2).slice(0, 500));
    return { success: true, latency, result };
  } catch (error) {
    const latency = Date.now() - start;
    console.log(`❌ FAILED (${latency}ms)`);
    console.log('Error:', error.message);
    if (error.logs) console.log('Logs:', error.logs);
    return { success: false, latency, error: error.message };
  }
}

async function runAudit() {
  console.log('🔍 RPC AUDIT: percolator-launch frontend');
  console.log('═'.repeat(60));
  console.log(`RPC Endpoint: ${RPC_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  const results = {};

  // 1. getAccountInfo for slab 1
  results.slab1 = await measureRPC(
    '1. getAccountInfo - Slab 1 (44GTcc...)',
    async () => {
      const accountInfo = await connection.getAccountInfo(new PublicKey(SLAB_1));
      return accountInfo ? { 
        exists: true, 
        owner: accountInfo.owner.toBase58(),
        dataLength: accountInfo.data.length,
        lamports: accountInfo.lamports
      } : { exists: false };
    }
  );

  // 2. getAccountInfo for slab 2
  results.slab2 = await measureRPC(
    '2. getAccountInfo - Slab 2 (8eFFEF...)',
    async () => {
      const accountInfo = await connection.getAccountInfo(new PublicKey(SLAB_2));
      return accountInfo ? { 
        exists: true, 
        owner: accountInfo.owner.toBase58(),
        dataLength: accountInfo.data.length,
        lamports: accountInfo.lamports
      } : { exists: false };
    }
  );

  // 3. getTokenAccountBalance - we need to find an ATA first
  results.tokenBalance = await measureRPC(
    '3. getTokenAccountBalance - Test ATA',
    async () => {
      // Try to get token accounts by owner for the test wallet
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        new PublicKey(TEST_WALLET),
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      
      if (tokenAccounts.value.length === 0) {
        // If no token accounts, just test the method with any public key
        // This will fail but shows the RPC accepts the method
        try {
          await connection.getTokenAccountBalance(new PublicKey(TEST_WALLET));
        } catch (e) {
          if (e.message.includes('could not find account')) {
            return { methodWorks: true, note: 'No token accounts found, but method is accessible' };
          }
          throw e;
        }
      }
      
      const firstATA = tokenAccounts.value[0].pubkey;
      const balance = await connection.getTokenAccountBalance(firstATA);
      return { 
        ata: firstATA.toBase58(),
        amount: balance.value.amount,
        decimals: balance.value.decimals,
        uiAmount: balance.value.uiAmount
      };
    }
  );

  // 4. getParsedAccountInfo for a mint
  results.parsedMint = await measureRPC(
    '4. getParsedAccountInfo - Mint',
    async () => {
      const accountInfo = await connection.getParsedAccountInfo(new PublicKey(TEST_MINT));
      return accountInfo.value ? {
        exists: true,
        owner: accountInfo.value.owner.toBase58(),
        parsed: accountInfo.value.data
      } : { exists: false };
    }
  );

  // 5. getBalance for a wallet
  results.balance = await measureRPC(
    '5. getBalance - Wallet',
    async () => {
      const balance = await connection.getBalance(new PublicKey(TEST_WALLET));
      return { 
        lamports: balance,
        sol: balance / 1e9
      };
    }
  );

  // 6. getSlot
  results.slot = await measureRPC(
    '6. getSlot',
    async () => {
      const slot = await connection.getSlot();
      return { currentSlot: slot };
    }
  );

  // 7. getLatestBlockhash
  results.blockhash = await measureRPC(
    '7. getLatestBlockhash',
    async () => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      return { 
        blockhash,
        lastValidBlockHeight
      };
    }
  );

  // 8. sendTransaction (dry-run - verify endpoint accepts the method)
  results.sendTx = await measureRPC(
    '8. sendTransaction - Method Check (not actually sending)',
    async () => {
      // Create a dummy transaction
      const dummyKeypair = Keypair.generate();
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: dummyKeypair.publicKey,
          toPubkey: dummyKeypair.publicKey,
          lamports: 1000,
        })
      );
      
      // Get recent blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = dummyKeypair.publicKey;
      
      // Sign with dummy keypair
      transaction.sign(dummyKeypair);
      
      // Try to send - this will fail due to insufficient funds, but proves the method works
      try {
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });
        return { methodWorks: true, signature };
      } catch (e) {
        // Expected to fail, but check the error type
        if (e.message.includes('insufficient funds') || 
            e.message.includes('Attempt to debit an account') ||
            e.message.includes('blockhash not found')) {
          return { 
            methodWorks: true, 
            note: 'Method accessible (failed as expected due to unfunded account or old blockhash)'
          };
        }
        throw e;
      }
    }
  );

  // Summary
  console.log('\n\n📊 AUDIT SUMMARY');
  console.log('═'.repeat(60));
  
  const tests = Object.entries(results);
  const passed = tests.filter(([_, r]) => r.success).length;
  const failed = tests.filter(([_, r]) => !r.success).length;
  
  console.log(`Total Tests: ${tests.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  
  console.log('\n📈 Latency Stats:');
  const latencies = tests.map(([_, r]) => r.latency);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);
  const minLatency = Math.min(...latencies);
  
  console.log(`  Average: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Min: ${minLatency}ms`);
  console.log(`  Max: ${maxLatency}ms`);
  
  if (failed > 0) {
    console.log('\n⚠️  FAILED TESTS:');
    tests.filter(([_, r]) => !r.success).forEach(([name, result]) => {
      console.log(`  - ${name}: ${result.error}`);
    });
  }
  
  console.log('\n' + '═'.repeat(60));
  console.log(passed === tests.length ? 
    '✅ ALL TESTS PASSED - RPC is fully operational' : 
    `⚠️  ${failed} test(s) failed - investigate before deployment`
  );
}

runAudit().catch(console.error);
