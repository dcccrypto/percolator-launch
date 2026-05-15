import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import fs from "fs";

const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) throw new Error("Set RPC_URL or HELIUS_API_KEY before running this script");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`, "utf8")
  )));

  // Swap 40 USDC for SOL (~0.06 SOL at $82)
  const amount = 40_000_000; // 40 USDC (6 decimals)
  
  console.log("Fetching Jupiter quote for 40 USDC → SOL...");
  const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${SOL}&amount=${amount}&slippageBps=100`);
  const quote = await quoteRes.json();
  console.log(`Quote: ${amount/1e6} USDC → ${Number(quote.outAmount)/1e9} SOL`);

  const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  const { swapTransaction } = await swapRes.json();

  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sig = await conn.sendTransaction(tx);
  console.log("Swap TX:", sig);
  await conn.confirmTransaction(sig, "confirmed");
  
  const bal = await conn.getBalance(wallet.publicKey);
  console.log(`New SOL balance: ${(bal/1e9).toFixed(4)}`);
}

main().catch(console.error);
