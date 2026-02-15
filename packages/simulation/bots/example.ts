/**
 * Example: Running the Bot Fleet
 * 
 * This demonstrates how to use the BotManager to run trading bots
 * that execute real trades on Solana devnet.
 * 
 * NOTE: This is an example only. Do not run without:
 * 1. Fixing account index parsing in BaseBot.createAccount()
 * 2. Completing instruction account lists in BaseBot trade methods
 * 3. Deploying a test slab on devnet
 */

import { BotManager } from "./BotManager.js";

async function runBotFleet() {
  console.log("🤖 Starting Percolator Bot Fleet...\n");
  
  // Configuration
  const SLAB_ADDRESS = "YOUR_SLAB_PUBKEY_HERE"; // Replace with actual slab
  const PROGRAM_ID = "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD";
  const RPC_URL = "https://api.devnet.solana.com";
  
  // Create bot manager with "Volatile Market" scenario
  const manager = new BotManager({
    slabAddress: SLAB_ADDRESS,
    programId: PROGRAM_ID,
    rpcUrl: RPC_URL,
    scenario: BotManager.SCENARIOS.VOLATILE, // MarketMaker + TrendFollower + Liquidation
  });
  
  try {
    // Step 1: Initialize bots (creates keypairs, airdrops SOL, creates accounts)
    console.log("📦 Initializing bots...");
    await manager.initializeBots();
    console.log("✅ Bots initialized\n");
    
    // Step 2: Start trading
    console.log("🚀 Starting bots...");
    manager.start();
    console.log("✅ Bots running\n");
    
    // Step 3: Simulate price updates (in production, this comes from PriceOracle)
    let currentPrice = 50_000_000n; // 50 USDC (e6 format)
    
    const priceUpdateInterval = setInterval(() => {
      // Simulate price movement (±0.5% random walk)
      const change = BigInt(Math.floor((Math.random() - 0.5) * 500_000)); // ±0.5 USDC
      currentPrice += change;
      
      // Ensure price stays positive
      if (currentPrice < 1_000_000n) {
        currentPrice = 1_000_000n;
      }
      
      // Update bots with new price
      manager.updatePrice(currentPrice);
      
      // Log price
      const priceUSD = Number(currentPrice) / 1_000_000;
      console.log(`💹 Price: $${priceUSD.toFixed(2)}`);
    }, 2000); // Update every 2 seconds
    
    // Step 4: Monitor bot activity
    const logInterval = setInterval(() => {
      const logs = manager.getLogs(5); // Last 5 logs
      if (logs.length > 0) {
        console.log("\n📊 Recent Activity:");
        logs.forEach(log => console.log(`   ${log}`));
      }
      
      const states = manager.getBotStates();
      console.log("\n🤖 Bot Status:");
      states.forEach(state => {
        const posSize = Number(state.positionSize) / 1_000_000;
        const posStr = state.positionSize === 0n 
          ? "FLAT" 
          : state.positionSize > 0n 
            ? `LONG ${posSize.toFixed(2)}M` 
            : `SHORT ${Math.abs(posSize).toFixed(2)}M`;
        
        console.log(`   ${state.name}: ${posStr} | Trades: ${state.tradesExecuted}`);
      });
      console.log("");
    }, 10000); // Log every 10 seconds
    
    // Run for 5 minutes, then stop
    setTimeout(() => {
      console.log("\n⏹️  Stopping bots...");
      clearInterval(priceUpdateInterval);
      clearInterval(logInterval);
      manager.stop();
      
      // Final summary
      const states = manager.getBotStates();
      const totalTrades = states.reduce((sum, s) => sum + s.tradesExecuted, 0);
      
      console.log("\n📈 Session Summary:");
      console.log(`   Total Trades: ${totalTrades}`);
      console.log(`   Bots Run: ${states.length}`);
      console.log(`   Duration: 5 minutes\n`);
      
      process.exit(0);
    }, 300_000); // 5 minutes
    
  } catch (error) {
    console.error("❌ Error running bot fleet:", error);
    process.exit(1);
  }
}

// Alternative: Run a crash scenario
async function runCrashScenario() {
  console.log("💥 Starting CRASH scenario...\n");
  
  const manager = new BotManager({
    slabAddress: "YOUR_SLAB_PUBKEY_HERE",
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    rpcUrl: "https://api.devnet.solana.com",
    scenario: BotManager.SCENARIOS.CRASH, // High aggression, all bots
  });
  
  await manager.initializeBots();
  manager.start();
  
  // Simulate a market crash
  let price = 50_000_000n; // Start at 50 USDC
  
  const crashInterval = setInterval(() => {
    // Price drops 2% per tick for 30 ticks = ~40% crash
    price = (price * 98n) / 100n;
    manager.updatePrice(price);
    
    console.log(`💥 CRASH: $${Number(price) / 1_000_000}`);
  }, 2000);
  
  // Stop after crash completes
  setTimeout(() => {
    clearInterval(crashInterval);
    manager.stop();
    
    const logs = manager.getLogs(20);
    console.log("\n🔥 Crash Event Log:");
    logs.forEach(log => console.log(`   ${log}`));
    
    process.exit(0);
  }, 60_000); // 1 minute
}

// Alternative: Whale manipulation
async function runWhaleAttack() {
  console.log("🐋 Starting WHALE ATTACK scenario...\n");
  
  const manager = new BotManager({
    slabAddress: "YOUR_SLAB_PUBKEY_HERE",
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    rpcUrl: "https://api.devnet.solana.com",
    scenario: BotManager.SCENARIOS.WHALE_ATTACK,
  });
  
  await manager.initializeBots();
  manager.start();
  
  // Normal price updates
  let price = 50_000_000n;
  setInterval(() => {
    manager.updatePrice(price);
  }, 2000);
  
  // Trigger whale after 30 seconds
  setTimeout(() => {
    console.log("🐋 TRIGGERING WHALE MANIPULATION...");
    const whale = manager.getBotStates().find(b => b.type === "whale");
    if (whale) {
      // This would require exposing trigger method
      // whale.trigger("manipulate");
      console.log("🐋 Whale activated");
    }
  }, 30_000);
  
  // Stop after 3 minutes
  setTimeout(() => {
    manager.stop();
    process.exit(0);
  }, 180_000);
}

// Run the default scenario
if (require.main === module) {
  runBotFleet().catch(console.error);
  
  // Uncomment to run alternative scenarios:
  // runCrashScenario().catch(console.error);
  // runWhaleAttack().catch(console.error);
}
