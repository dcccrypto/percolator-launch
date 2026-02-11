import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Test additional RPC methods used by frontend
async function testSupplemental() {
  console.log('🔍 Supplemental RPC Tests');
  console.log('═'.repeat(60));
  
  // 9. getSignatureStatuses (used in tx.ts for transaction confirmation)
  console.log('\n🧪 Testing: getSignatureStatuses');
  console.log('─'.repeat(60));
  const start = Date.now();
  try {
    // First get a recent signature from the network
    const testWallet = new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy');
    const signatures = await connection.getSignaturesForAddress(testWallet, { limit: 1 });
    
    if (signatures.length === 0) {
      console.log('⚠️  No signatures found for test wallet, using null signature test');
      // Test with empty array to verify method accessibility
      const result = await connection.getSignatureStatuses([], {
        searchTransactionHistory: false
      });
      const latency = Date.now() - start;
      console.log(`✅ SUCCESS (${latency}ms)`);
      console.log('Method is accessible (tested with empty array)');
    } else {
      const sig = signatures[0].signature;
      const result = await connection.getSignatureStatuses([sig], {
        searchTransactionHistory: true
      });
      const latency = Date.now() - start;
      console.log(`✅ SUCCESS (${latency}ms)`);
      console.log('Tested with signature:', sig.slice(0, 20) + '...');
      console.log('Status:', result.value[0] ? 'Found' : 'Not found');
    }
  } catch (error) {
    const latency = Date.now() - start;
    console.log(`❌ FAILED (${latency}ms)`);
    console.log('Error:', error.message);
  }
  
  // 10. getTokenAccountsByOwner (used in getTokenAccountBalance test)
  console.log('\n🧪 Testing: getTokenAccountsByOwner');
  console.log('─'.repeat(60));
  const start2 = Date.now();
  try {
    const testWallet = new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy');
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const accounts = await connection.getTokenAccountsByOwner(testWallet, {
      programId: TOKEN_PROGRAM
    });
    const latency2 = Date.now() - start2;
    console.log(`✅ SUCCESS (${latency2}ms)`);
    console.log(`Found ${accounts.value.length} token accounts`);
    if (accounts.value.length > 0) {
      console.log('First account:', accounts.value[0].pubkey.toBase58());
    }
  } catch (error) {
    const latency2 = Date.now() - start2;
    console.log(`❌ FAILED (${latency2}ms)`);
    console.log('Error:', error.message);
  }
  
  console.log('\n' + '═'.repeat(60));
  console.log('✅ Supplemental tests complete');
}

testSupplemental().catch(console.error);
