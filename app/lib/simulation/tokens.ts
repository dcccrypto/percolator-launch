/**
 * Random token generator for simulation mode.
 * Pool of memecoin-style tokens that never repeat within a session.
 */

export interface SimToken {
  name: string;
  symbol: string;
  description: string;
  decimals: 6;
}

const TOKEN_POOL: Omit<SimToken, "decimals">[] = [
  { symbol: "PERC", name: "Percolator Cat", description: "The purrfect perp" },
  { symbol: "DRIP", name: "Drip Protocol", description: "Slow and steady gains" },
  { symbol: "MELT", name: "Meltdown Token", description: "When markets go nuclear" },
  { symbol: "BONK2", name: "Bonk Returns", description: "He's back" },
  { symbol: "COPE", name: "Copium", description: "For when you get liquidated" },
  { symbol: "BREW", name: "BrewCoin", description: "Fresh off the press" },
  { symbol: "GRIND", name: "Grindstone", description: "No sleep till profit" },
  { symbol: "FOMO", name: "Fear of Missing Out", description: "You should have aped earlier" },
  { symbol: "REKT", name: "Rekt Finance", description: "Everyone gets rekt eventually" },
  { symbol: "MOON", name: "Moonshot", description: "Destination: escape velocity" },
  { symbol: "DEGEN", name: "DegenCoin", description: "Professional risk ignorer" },
  { symbol: "PUMP", name: "PumpIt", description: "Only goes up (sometimes)" },
  { symbol: "DUMP", name: "DumpCoin", description: "The other side of pump" },
  { symbol: "YOLO", name: "YOLO Finance", description: "One life, one leverage" },
  { symbol: "SHILL", name: "ShillToken", description: "Trust me bro" },
  { symbol: "PAPER", name: "Paper Hands", description: "Sold too early since 2021" },
  { symbol: "DIAMOND", name: "Diamond Hands", description: "Never selling, ever" },
  { symbol: "RUGGED", name: "RugPull Survivor", description: "Battle-tested and broke" },
  { symbol: "NGMI", name: "Not Gonna Make It", description: "The self-aware token" },
  { symbol: "WAGMI", name: "We All Gonna Make It", description: "Eternal optimism coin" },
  { symbol: "GAS", name: "Gas Fee Token", description: "More expensive than the trade" },
  { symbol: "SLURP", name: "SlurpJuice", description: "Absorbing all liquidity" },
  { symbol: "CHAD", name: "GigaChad Token", description: "Maximum sigma energy" },
  { symbol: "JEET", name: "Jeet Protocol", description: "Sells at first green candle" },
  { symbol: "SNIPE", name: "SniperBot", description: "Front-running since genesis" },
  { symbol: "MEV", name: "MEV Extracted", description: "Your sandwich, served fresh" },
  { symbol: "LAMBO", name: "LamboCoin", description: "When lambo? When profit." },
  { symbol: "TARD", name: "RetardIO", description: "Proud member of the community" },
  { symbol: "APE", name: "ApeStrong", description: "Ape first, think never" },
  { symbol: "WHALE", name: "WhaleAlert", description: "Moving markets since block 0" },
  { symbol: "SHRIMP", name: "Shrimp Finance", description: "Small but determined" },
  { symbol: "BAGS", name: "Heavy Bags", description: "Still holding from ATH" },
  { symbol: "ALPHA", name: "Alpha Leak", description: "Insider info or just noise" },
  { symbol: "FLIP", name: "FlipCoin", description: "50/50 every time" },
  { symbol: "HEDGE", name: "HedgeFund Jr", description: "Sophisticated losing" },
  { symbol: "LARP", name: "LarpDAO", description: "Pretending to be profitable" },
  { symbol: "NUKE", name: "NukeProtocol", description: "Obliterating portfolios" },
  { symbol: "COPTER", name: "Helicopter Money", description: "Printing goes brrr" },
  { symbol: "PAMP", name: "Pamp Token", description: "Pamp eet, load ze Korea FUD" },
  { symbol: "BOGD", name: "Bogdanoff", description: "He bought? Damp eet." },
  { symbol: "CANDLE", name: "Green Candle", description: "The color of hope" },
  { symbol: "WICK", name: "WickHunter", description: "Liquidation artist" },
  { symbol: "LEVER", name: "LeverageMax", description: "100x or homeless" },
  { symbol: "FUND", name: "FundingSafu", description: "Funds are definitely safu" },
  { symbol: "LICK", name: "Liquidated", description: "Margin called at 3am" },
  { symbol: "SCAM", name: "ScamCoin Official", description: "At least we're honest" },
  { symbol: "PEPE2", name: "Pepe Reborn", description: "The frog never dies" },
  { symbol: "GWEI", name: "Gwei Away", description: "Fees ate my lunch money" },
  { symbol: "RATS", name: "DeFi Rats", description: "First in, first out (hopefully)" },
  { symbol: "EXIT", name: "Exit Liquidity", description: "You are the product" },
  { symbol: "BRRR", name: "Money Printer", description: "Central bank cosplay" },
  { symbol: "DEAD", name: "DeadCat Bounce", description: "Looks alive but isn't" },
  { symbol: "GHOST", name: "Ghost Chain", description: "Zero users, max hype" },
];

/** Track used tokens within this server process lifetime */
const usedIndices = new Set<number>();

/**
 * Get a random token from the pool. Never repeats within same session.
 * Resets when pool is exhausted.
 */
export function getRandomToken(): SimToken {
  // Reset if exhausted
  if (usedIndices.size >= TOKEN_POOL.length) {
    usedIndices.clear();
  }

  let idx: number;
  do {
    idx = Math.floor(Math.random() * TOKEN_POOL.length);
  } while (usedIndices.has(idx));

  usedIndices.add(idx);
  const token = TOKEN_POOL[idx];

  return {
    ...token,
    decimals: 6,
  };
}

/**
 * Reset the used token tracker (for testing).
 */
export function resetTokenPool(): void {
  usedIndices.clear();
}
