import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD');

/**
 * PushOraclePrice instruction tag = 17
 * Layout: tag(1) + priceE6(8 as u64) + timestamp(8 as i64) = 17 bytes
 */
function encodePushOraclePrice(priceE6: bigint, timestamp: bigint): Buffer {
  const buf = Buffer.alloc(17);
  buf.writeUint8(17, 0);  // instruction tag
  buf.writeBigUInt64LE(priceE6, 1);  // priceE6
  buf.writeBigInt64LE(timestamp, 9);  // timestamp
  return buf;
}

/**
 * Load the simulation oracle authority keypair from environment variable
 * Supports both JSON array format [1,2,3,...] and base58 string
 * @returns Keypair or null if not configured
 */
export function loadOracleKeypair(): Keypair | null {
  const keypairStr = process.env.SIMULATION_ORACLE_KEYPAIR;
  if (!keypairStr) return null;
  
  try {
    // Try JSON array format first (standard Solana CLI output)
    if (keypairStr.trim().startsWith('[')) {
      const secretKey = Uint8Array.from(JSON.parse(keypairStr));
      return Keypair.fromSecretKey(secretKey);
    }
    
    // Otherwise assume it's base58 - decode using Buffer
    // This works because Node.js Buffer supports base58 via 'base58' encoding in some environments
    // For production, you'd want to add bs58 package or use JSON format
    throw new Error('Base58 format not supported. Please use JSON array format: [1,2,3,...]');
  } catch (error) {
    console.error('Failed to load SIMULATION_ORACLE_KEYPAIR:', error);
    console.error('Expected format: JSON array like [1,2,3,...,64]');
    return null;
  }
}

/**
 * Send a PushOraclePrice instruction to Solana
 * Accounts: [authority (signer), slab (writable)]
 * 
 * @param connection Solana connection
 * @param authorityKeypair Oracle authority keypair (must match slab's oracle_authority)
 * @param slabAddress Slab public key address (string)
 * @param priceE6 Price in micro-units (1 USDC = 1,000,000)
 * @returns Transaction signature
 */
export async function pushOraclePrice(
  connection: Connection,
  authorityKeypair: Keypair,
  slabAddress: string,
  priceE6: number,
): Promise<string> {
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKeypair.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(slabAddress), isSigner: false, isWritable: true },
    ],
    data: encodePushOraclePrice(BigInt(priceE6), BigInt(Math.floor(Date.now() / 1000))),
  });
  
  const tx = new Transaction().add(ix);
  const sig = await connection.sendTransaction(tx, [authorityKeypair], {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}
