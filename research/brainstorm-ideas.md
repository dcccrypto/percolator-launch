# Percolator Innovation Brainstorm
*Generated: 2026-02-14*

**Mission:** Identify breakthrough opportunities that differentiate Percolator from existing perp DEXs (Drift, Jupiter Perps, Mango).

---

## 1. Unique Value Propositions

### 1.1 Coin-Margined "Native Yield" Stacking
**Description:** Users earn native staking/DeFi yields on their coin-margined collateral while trading. For example, SOL collateral auto-stakes via Jito/Marinade, JUP collateral earns JLP yields, etc.

**Why it matters:** 
- Competitors use USDC margin → no yield on idle capital
- Percolator can offer 5-8% APY on collateral PLUS trading returns
- "Your collateral works harder than you do"

**Feasibility:** Medium (requires liquid staking integration, accounting complexity)  
**Impact:** HIGH - Pure alpha generation, sticky TVL  
**Timeline:** Post-mainnet (v1.5)

---

### 1.2 "Schelling Point Markets" - Community Signal Aggregation
**Description:** Permissionless market creation becomes a *feature*, not a bug. Markets act as prediction signals. The most-traded markets get promoted, creating a self-organizing marketplace of what traders actually care about.

**Why it matters:**
- Drift/Jupiter: curated markets, slow to add new assets
- Percolator: If 1000 traders open TRUMP/USD positions, that market auto-promotes
- Captures memecoin/narrative momentum FAST

**Feasibility:** Easy (market ranking by volume/OI already exists)  
**Impact:** HIGH - First-mover on narrative trades  
**Timeline:** PRE-MAINNET (quick win for hackathon demo)

---

### 1.3 "Percolator Points" - Retroactive Airdrop Farming Gamification
**Description:** Every trade, liquidation, LP provision, market creation earns points. Transparent leaderboard. Future token airdrop based on points + early participation bonuses.

**Why it matters:**
- Hyperliquid proven this model = $10B TVL in months
- Early users become evangelists
- Creates urgency ("ape in now before mainnet")

**Feasibility:** Easy (off-chain points tracking, simple DB)  
**Impact:** HIGH - User acquisition rocket fuel  
**Timeline:** PRE-MAINNET (launch with testnet v2)

---

### 1.4 Coin-Margined Multi-Collateral Portfolios
**Description:** Instead of single-asset margin, users deposit a basket (SOL + JUP + BONK) and Percolator auto-balances risk weights. Trade any market from any collateral.

**Why it matters:**
- Capital efficiency: Don't need to convert everything to USDC
- Solana ecosystem native (hold the bags you believe in)
- Lower slippage on deposits/withdrawals

**Feasibility:** Hard (complex risk engine, oracle dependencies)  
**Impact:** MEDIUM - Nice-to-have, not killer feature  
**Timeline:** Post-mainnet (v2)

---

## 2. Risk Engine Innovation

### 2.1 "Bounty Hunter" Liquidations
**Description:** Anyone can run a liquidator bot. Liquidation rewards are 50% higher than competitors (2-5% vs typical 1-2%). Gamify with leaderboards, "Liquidator of the Week" badges.

**Why it matters:**
- More liquidators = healthier markets, faster unwinds
- Community becomes the risk backstop (decentralized)
- Incentivizes technical participants to stick around

**Feasibility:** Easy (adjust liquidation parameters)  
**Impact:** MEDIUM - Improves reliability, attracts devs  
**Timeline:** PRE-MAINNET (testnet stress testing)

---

### 2.2 Dynamic Risk Parameters via Oracle Network
**Description:** Risk parameters (margin requirements, funding rates) adjust in real-time based on:
- Market volatility (Pyth/Switchboard data)
- Liquidity depth (Jupiter aggregator)
- Cross-chain correlation (if BTC dumps, tighten all crypto pairs)

**Why it matters:**
- Static parameters = either too loose (risky) or too tight (capital inefficient)
- Adaptive = optimal risk/reward at all times
- "Smart money follows smart risk"

**Feasibility:** Medium (requires robust oracle infra, backtesting)  
**Impact:** HIGH - Core competitive advantage  
**Timeline:** Post-mainnet (v1.2)

---

### 2.3 "Insurance DAO" - Community-Owned Risk Pool
**Description:** Instead of protocol-owned insurance fund, launch a DAO vault where:
- Anyone deposits capital → earns yield from liquidation fees
- Vault backstops bad debt (socializes losses across willing participants)
- DAO votes on risk parameter changes

**Why it matters:**
- Aligns incentives (insurance providers = risk managers)
- Transparent vs black-box insurance funds
- Additional yield product for capital providers

**Feasibility:** Medium (governance overhead, legal/regulatory gray area)  
**Impact:** MEDIUM - Narrative play, "truly decentralized"  
**Timeline:** Post-mainnet (v2 + token launch)

---

### 2.4 "Rage Quit" Gradual Liquidation
**Description:** Instead of instant liquidation at threshold, positions auto-reduce in 10% increments as they approach liquidation. User keeps 90% → 80% → 70% exposure, avoiding full wipeout.

**Why it matters:**
- Better UX (no "rekt in one candle" moments)
- Reduces bad debt risk (gradual vs cliff edge)
- Users keep skin in the game if trend reverses

**Feasibility:** Medium (requires careful tuning to prevent gaming)  
**Impact:** HIGH - User retention, reduces rekt memes  
**Timeline:** Post-mainnet (v1.5)

---

## 3. Permissionless Market Safeguards

### 3.1 Market Creator Reputation Score
**Description:** Track record for each market creator:
- Markets created
- Total volume generated
- Dispute rate (oracle failures, manipulation)
- Community upvotes/downvotes

Markets from high-rep creators get featured placement.

**Why it matters:**
- Permissionless doesn't mean unfiltered chaos
- Good actors get rewarded (visibility → volume → fees)
- Scam markets sink to bottom

**Feasibility:** Easy (on-chain tracking, simple scoring algorithm)  
**Impact:** MEDIUM - Quality control without centralization  
**Timeline:** PRE-MAINNET (v1.0 feature)

---

### 3.2 "Progressive Decentralization" Bonding Curve
**Description:** New markets require creator to bond tokens (e.g., 100 USDC). As market proves itself (volume/OI thresholds), bond unlocks in stages. Failed markets forfeit bond to insurance fund.

**Why it matters:**
- Skin in the game for market creators
- Filters out spam/scam markets
- Self-funding mechanism for insurance

**Feasibility:** Easy (smart contract escrow)  
**Impact:** HIGH - Spam filter + revenue generation  
**Timeline:** PRE-MAINNET (critical for permissionless safety)

---

### 3.3 Community Curation via Prediction Markets
**Description:** Before a new market goes live, community votes with real money:
- "Will this market do >$1M volume in first week?" (Yes/No prediction market)
- Correct predictors earn rewards
- High-confidence markets get fast-tracked

**Why it matters:**
- Wisdom of crowds filters quality
- Meta-game: prediction markets about prediction markets
- Self-reinforcing flywheel (good curators stick around)

**Feasibility:** Hard (meta-complexity, potential for manipulation)  
**Impact:** MEDIUM - Cool experiment, unclear PMF  
**Timeline:** Post-mainnet (v2 - experimental)

---

### 3.4 Oracle Aggregation for Long-Tail Assets
**Description:** For niche/memecoin markets, aggregate multiple oracle sources:
- Pyth (primary)
- Switchboard (secondary)
- TWAP from Jupiter/Raydium
- Outlier detection + median-based pricing

**Why it matters:**
- Single oracle = manipulation risk on low-liquidity assets
- Multi-source = robust against flash crashes
- Enables permissionless markets for anything with a DEX pool

**Feasibility:** Medium (oracle coordination, latency management)  
**Impact:** HIGH - Unlocks long-tail markets safely  
**Timeline:** PRE-MAINNET (critical path item)

---

## 4. Capital Efficiency

### 4.1 Cross-Margin "Portfolio Mode"
**Description:** Single collateral pool backs ALL positions. Long SOL + Short ETH nets out correlation risk → higher effective leverage.

**Why it matters:**
- Competitors: isolated margin = capital inefficient
- Sophisticated traders can run complex strategies with less capital
- "Unlock 30% more buying power"

**Feasibility:** Medium (complex risk calculations, liquidation logic)  
**Impact:** HIGH - Pro trader magnet  
**Timeline:** Post-mainnet (v1.3)

---

### 4.2 LP Auto-Compounding Vaults
**Description:** LPs don't just earn fees → fees auto-reinvest into LP position (compound growth). Gamified "set it and forget it" passive income.

**Why it matters:**
- Better APY than manual claiming
- Sticky liquidity (compound interest psychology)
- Lower gas friction (auto-reinvest vs manual claims)

**Feasibility:** Easy (Solana = cheap gas, simple vault logic)  
**Impact:** MEDIUM - LP retention, TVL growth  
**Timeline:** PRE-MAINNET (low-hanging fruit)

---

### 4.3 Flash Loan Liquidations
**Description:** Liquidators don't need upfront capital → borrow via flash loan, execute liquidation, repay + profit in single atomic transaction.

**Why it matters:**
- Lower barrier to entry for liquidators
- More competition → tighter spreads, healthier markets
- Solana's speed makes this viable (sub-400ms transactions)

**Feasibility:** Medium (flash loan integration, MEV considerations)  
**Impact:** MEDIUM - Liquidator diversity  
**Timeline:** Post-mainnet (v1.5)

---

### 4.4 "Leverage Ladder" - Tiered Margin Requirements
**Description:** Smaller positions = higher leverage allowed. As position size grows, margin requirements increase progressively (e.g., 20x up to $10K, 10x up to $100K, 5x beyond).

**Why it matters:**
- Protects against whale manipulation/blowups
- Enables retail degens to ape with high leverage (user acquisition)
- Adaptive risk scaling

**Feasibility:** Easy (smart contract parameter table)  
**Impact:** MEDIUM - Balances degen appeal with safety  
**Timeline:** PRE-MAINNET (v1.0 feature)

---

## 5. UX/Growth Hacks

### 5.1 "Shadow Trader" - Anonymous Copy Trading
**Description:** Top traders can choose to make their positions public (encrypted, no identity). Others copy-trade for a fee (e.g., 10% profit share). Leader earns passive income, followers get alpha.

**Why it matters:**
- Social proof drives FOMO ("whale just opened 100 SOL long")
- Revenue share for influencers → organic marketing
- Lowers skill barrier for newbies

**Feasibility:** Medium (privacy tech, fee routing, UX complexity)  
**Impact:** HIGH - Viral growth loop  
**Timeline:** Post-mainnet (v2)

---

### 5.2 "Paper Trading" Onboarding Mode
**Description:** New users start in simulation mode with fake $10K. Full UI/UX identical to real trading. After X profitable trades or completion of tutorial, unlock mainnet with bonus (e.g., $50 USDC airdrop).

**Why it matters:**
- Removes fear of losing real money (newbie barrier)
- Educational without being boring
- Qualified leads (users who complete paper trading = serious traders)

**Feasibility:** Easy (separate state management, simple DB)  
**Impact:** HIGH - Conversion funnel optimization  
**Timeline:** PRE-MAINNET (demo-ready for hackathon)

---

### 5.3 Leaderboards + "Trader Rank" NFTs
**Description:** Weekly/monthly leaderboards by PnL, volume, win rate. Top performers earn NFT badges (Bronze/Silver/Gold/Diamond Trader). NFTs unlock perks (fee discounts, early market access).

**Why it matters:**
- Gamification = engagement = retention
- NFT flex culture (status signaling)
- Competitive traders are most valuable users (volume generators)

**Feasibility:** Easy (NFT minting on Solana is trivial)  
**Impact:** MEDIUM - Retention mechanic  
**Timeline:** PRE-MAINNET (nice-to-have for launch)

---

### 5.4 Mobile-First Progressive Web App (PWA)
**Description:** No app store required. Fully responsive PWA works on iPhone/Android with push notifications for liquidation warnings, funding rate changes, position PnL alerts.

**Why it matters:**
- Solana Mobile Stack integration (Saga phone users)
- Faster iteration (no app store approval delays)
- Push notifications = re-engagement

**Feasibility:** Easy (modern web tech, Solana wallet adapters support mobile)  
**Impact:** MEDIUM - Mobile users are underserved in perp DEX space  
**Timeline:** PRE-MAINNET (mobile-responsive at launch)

---

### 5.5 "Explain Like I'm 5" Tooltips + Interactive Tutorials
**Description:** Every complex term (funding rate, mark price, liquidation) has a hover tooltip with plain English explanation + link to interactive demo. Contextual help everywhere.

**Why it matters:**
- Perps are intimidating for non-degens
- Lower learning curve = broader market
- Competitors have terrible UX for beginners

**Feasibility:** Easy (UI/UX work, no smart contract changes)  
**Impact:** MEDIUM - User acquisition from non-crypto-native crowd  
**Timeline:** PRE-MAINNET (polish phase)

---

## 6. Ecosystem Integration

### 6.1 Jupiter Aggregator Integration (Swap-to-Trade)
**Description:** User wants to trade SOL/USD but only has USDC → one-click swap USDC → SOL via Jupiter, then open position. All in single transaction.

**Why it matters:**
- Removes friction (no manual swapping)
- Jupiter routing = best execution
- Composability showcase (Solana superpower)

**Feasibility:** Easy (Jupiter API is well-documented)  
**Impact:** HIGH - UX improvement, capital efficiency  
**Timeline:** PRE-MAINNET (quick integration)

---

### 6.2 Phantom/Backpack Deep Linking
**Description:** Partner with wallets to add "Trade Perps" button directly in wallet UI. One tap from wallet → open position on Percolator.

**Why it matters:**
- Distribution (millions of wallet users see Percolator)
- Native integration = trust signal
- Reduce user journey friction

**Feasibility:** Medium (requires partnership, wallet team bandwidth)  
**Impact:** HIGH - Marketing/distribution multiplier  
**Timeline:** Post-mainnet (BD-dependent)

---

### 6.3 Solana Mobile Stack - Saga Phone Integration
**Description:** Exclusive features for Saga users:
- Mobile-optimized trading UI
- Hardware wallet signing (secure)
- NFT rewards for Saga holders

**Why it matters:**
- Saga community is high-value crypto natives
- Early adopter audience (perfect fit)
- Solana Foundation might promote (grant opportunities)

**Feasibility:** Easy (mobile PWA + wallet detection)  
**Impact:** MEDIUM - Niche but high-signal users  
**Timeline:** PRE-MAINNET (if Saga wallet detection works)

---

### 6.4 Cross-Protocol Collateral (Marginfi, Kamino, Drift)
**Description:** Accept LP tokens from other DeFi protocols as collateral:
- JLP (Jupiter LP) → trade perps while earning JLP yield
- mSOL (Marinade staked SOL) → liquid staking + leverage
- Kamino vault shares → auto-compounding + perp exposure

**Why it matters:**
- Capital efficiency: double-dipping yield
- Attract liquidity from across Solana DeFi
- Composability moat

**Feasibility:** Hard (oracle pricing for LP tokens, liquidation complexity)  
**Impact:** HIGH - Differentiated capital efficiency  
**Timeline:** Post-mainnet (v2)

---

## 7. Governance & Decentralization

### 7.1 Progressive Decentralization Roadmap (Transparent)
**Description:** Public roadmap with milestones:
- Phase 1: Team-controlled (mainnet launch)
- Phase 2: DAO votes on risk parameters (6 months)
- Phase 3: Protocol upgrade governance (12 months)
- Phase 4: Full DAO ownership (18 months)

**Why it matters:**
- Transparency builds trust
- Gradual transition avoids governance attacks
- Token airdrop aligns with decentralization timeline

**Feasibility:** Easy (documentation + commitment)  
**Impact:** MEDIUM - Narrative/trust-building  
**Timeline:** PRE-MAINNET (publish roadmap at launch)

---

### 7.2 "Percolator Improvement Proposals" (PIPs)
**Description:** GitHub-based proposal system (like Ethereum's EIPs):
- Anyone can submit PIP
- Community discussion
- DAO vote for implementation
- Approved PIPs get bounty funding

**Why it matters:**
- Open-source ethos (community ownership)
- Attracts builder talent (bounty incentives)
- Bug bounties already working → expand to features

**Feasibility:** Easy (GitHub repo + governance framework)  
**Impact:** MEDIUM - Community engagement  
**Timeline:** PRE-MAINNET (set up framework)

---

### 7.3 Risk Parameter DAO with Skin-in-the-Game Voting
**Description:** To vote on risk parameters (leverage limits, liquidation thresholds), must stake tokens. Votes are weighted by stake + historical accuracy (good votes = more voting power over time).

**Why it matters:**
- Prevents governance attacks (must have capital at risk)
- Reputation system = experts naturally gain influence
- Aligns incentives (bad votes hurt your portfolio)

**Feasibility:** Medium (voting contract + reputation tracking)  
**Impact:** HIGH - Credible decentralization  
**Timeline:** Post-mainnet (with token launch)

---

### 7.4 Community Treasury - Fee Revenue Sharing
**Description:** 50% of protocol fees → DAO treasury. DAO votes on:
- Grant funding for builders
- Marketing campaigns
- Insurance fund contributions
- Token buybacks/burns

**Why it matters:**
- Sustainable funding for growth
- Community owns the upside
- Token value accrual mechanism

**Feasibility:** Easy (fee routing in smart contract)  
**Impact:** HIGH - Token economics foundation  
**Timeline:** Post-mainnet (with token launch)

---

## 8. Pump.fun Hackathon Angle

### 8.1 "First Truly Permissionless Perp DEX" Narrative
**Description:** Demo video showing:
1. User creates BONK/USD market in 30 seconds (no permission)
2. Market goes live, others trade immediately
3. Creator earns fees
4. Show leaderboard of top market creators

**Why it matters:**
- Clear differentiation from competitors
- Solana ethos (permissionless innovation)
- Judges will remember the demo

**Feasibility:** Easy (demo script + testnet)  
**Impact:** HIGH - Hackathon positioning  
**Timeline:** PRE-MAINNET (ready by Feb 18)

---

### 8.2 Live Testnet Competition at Hackathon
**Description:** During demo, invite judges to:
- Create their own market
- Trade against each other
- Winner (most PnL after 10 minutes) gets NFT prize

**Why it matters:**
- Interactive > passive presentation
- Memorable experience
- Shows product actually works (not just slides)

**Feasibility:** Easy (testnet + pre-loaded demo accounts)  
**Impact:** HIGH - Demo differentiation  
**Timeline:** PRE-MAINNET (demo prep)

---

### 8.3 "Powered by Pump.fun" Integration Concept
**Description:** Pitch a future integration where:
- New Pump.fun token launches → auto-create perp market
- Traders can long/short new memecoins from day 1
- Pump.fun gets fee share

**Why it matters:**
- Synergy with Pump.fun (hackathon sponsor/organizer)
- Shows vision beyond hackathon
- Memecoin perps = unexplored market

**Feasibility:** Medium (requires Pump.fun partnership, oracle challenges)  
**Impact:** HIGH - Hackathon narrative alignment  
**Timeline:** Post-mainnet (pitch as future roadmap)

---

### 8.4 Open-Source from Day 1
**Description:** All code on GitHub, MIT license. Emphasize in pitch:
- "We're building a public good"
- Community can fork, improve, audit
- Bug bounties already live (show GitHub issues)

**Why it matters:**
- Hackathon judges value open-source ethos
- Credibility (nothing to hide)
- Community building from launch

**Feasibility:** Easy (already planning this)  
**Impact:** MEDIUM - Ethos/trust signal  
**Timeline:** PRE-MAINNET (GitHub public at demo)

---

## 9. Moonshot Ideas

### 9.1 Prediction Markets + Perps Hybrid
**Description:** Markets like "Will SOL hit $200 by March?" can be:
- Binary outcome prediction market (Polymarket style)
- OR perpetual market that settles at $1 if true, $0 if false
- Traders can switch between modes

**Why it matters:**
- Expands TAM (prediction market users + perp traders)
- Novel product (doesn't exist elsewhere)
- Narrative/event-driven trading

**Feasibility:** Hard (complex settlement logic, UX confusion risk)  
**Impact:** HIGH - Category creation  
**Timeline:** Post-mainnet (v3 - experimental)

---

### 9.2 NFT-Backed Leverage (NFTs as Collateral)
**Description:** Deposit blue-chip NFTs (SMB, Mad Lads, Tensorians) as collateral:
- Oracle pricing via Tensor/Magic Eden floor price
- Higher margin requirements (conservative LTV)
- Liquidation → NFT auto-listed on marketplace

**Why it matters:**
- Unlocks liquidity for NFT holders
- Cross-pollinate communities (NFT degens → perp traders)
- Solana-native feature (NFT culture strong here)

**Feasibility:** Hard (NFT oracles, liquidation complexity, illiquid markets)  
**Impact:** MEDIUM - Niche but viral potential  
**Timeline:** Post-mainnet (v3 - if NFT market recovers)

---

### 9.3 AI-Driven Risk Management Assistant
**Description:** AI agent monitors user positions, provides:
- Liquidation warnings ("SOL down 5%, you're 80% to liquidation")
- Suggested hedge trades ("Consider shorting ETH to reduce correlation risk")
- Market regime detection ("Volatility spiking, tighten stops")

**Why it matters:**
- Differentiates UX (smart assistant vs dumb interface)
- Reduces rekt rate → user retention
- AI narrative = media attention

**Feasibility:** Hard (ML models, real-time inference, accuracy requirements)  
**Impact:** HIGH - UX moat if done well  
**Timeline:** Post-mainnet (v2 - requires data collection first)

---

### 9.4 Decentralized Oracle Network (Community Price Feeds)
**Description:** Incentivized network where:
- Stakers run price feed nodes
- Submit prices, get rewarded for accuracy
- Outliers get slashed
- Aggregated feed used for niche markets

**Why it matters:**
- Independence from Pyth/Switchboard (decentralization maximalism)
- Enables truly permissionless markets (no oracle gatekeepers)
- Token utility (staking for oracle rewards)

**Feasibility:** Hard (complex game theory, bootstrap problem)  
**Impact:** HIGH - Long-term decentralization vision  
**Timeline:** Post-mainnet (v3+ / separate product)

---

### 9.5 Options + Perps Hybrid (Perpetual Options)
**Description:** Perpetual contracts that behave like options:
- No expiry (like perps)
- Pay funding rate based on intrinsic value (like options premium)
- Unlimited upside, limited downside (put/call mechanics)

**Why it matters:**
- Options are huge in TradFi, tiny in DeFi
- Complexity scares users → simplified perpetual version
- Novel product, no competition

**Feasibility:** Very Hard (unproven mechanism design, pricing challenges)  
**Impact:** HIGH - Blue ocean if it works  
**Timeline:** Post-mainnet (v4 - research phase)

---

## Summary: Quick Wins vs Long Bets

### 🚀 QUICK WINS (Pre-Mainnet / Hackathon Demo)
1. **Schelling Point Markets** (auto-promote high-volume markets)
2. **Percolator Points** (retroactive airdrop farming)
3. **Market Creator Reputation Score**
4. **Progressive Decentralization Bonding Curve** (spam filter)
5. **Paper Trading Onboarding**
6. **Jupiter Swap-to-Trade Integration**
7. **Mobile PWA**
8. **Open-Source GitHub Launch**
9. **Hackathon Live Demo Competition**

### 🎯 MEDIUM-TERM BETS (Post-Mainnet, 3-6 months)
1. **Coin-Margined Native Yield** (staking integration)
2. **Dynamic Risk Parameters** (oracle-driven)
3. **Bounty Hunter Liquidations** (gamified)
4. **Cross-Margin Portfolio Mode**
5. **Shadow Trader (Copy Trading)**
6. **Wallet Deep Linking Partnerships**
7. **Risk Parameter DAO**
8. **Community Treasury**

### 🌙 MOONSHOTS (v2+, 6-12+ months)
1. **Prediction Markets Hybrid**
2. **NFT-Backed Leverage**
3. **AI Risk Management Assistant**
4. **Decentralized Oracle Network**
5. **Perpetual Options**
6. **Cross-Protocol Collateral** (LP tokens)

---

## Competitive Positioning Matrix

| Feature | Drift | Jupiter Perps | Mango | **Percolator** |
|---------|-------|---------------|-------|----------------|
| **Margin Type** | USDC | USDC | Multi-token | **Coin-margined + yield** |
| **Market Creation** | Permissioned | Permissioned | Permissioned | **Permissionless** |
| **Liquidations** | In-house | In-house | Public | **Gamified bounties** |
| **Copy Trading** | ❌ | ❌ | ❌ | **✅** |
| **Points Program** | ❌ | Planned | ❌ | **✅ (Day 1)** |
| **Mobile UX** | Basic | Basic | Basic | **PWA native** |
| **Open Source** | Partial | ❌ | ✅ | **✅ + Bug bounties** |
| **DAO Governance** | Future | ❌ | ✅ | **Progressive roadmap** |
| **Unique Moat** | Liquidity | Jupiter brand | OG status | **Permissionless + community** |

---

## Recommended Next Steps

### For Hackathon (by Feb 18):
1. ✅ Implement **market auto-promotion** (Schelling Point)
2. ✅ Launch **Percolator Points** testnet leaderboard
3. ✅ Add **paper trading mode** for demo
4. ✅ Polish **mobile PWA** experience
5. ✅ Prepare **live interactive demo** script
6. ✅ Publish **progressive decentralization roadmap**

### For Mainnet Launch (March-April):
1. 🎯 Integrate **Jupiter swap-to-trade**
2. 🎯 Implement **bonding curve for market creators**
3. 🎯 Deploy **LP auto-compounding vaults**
4. 🎯 Partner with **Phantom/Backpack** for deep linking
5. 🎯 Launch **bug bounty program v2** (expanded scope)

### For V2 (6+ months):
1. 🌙 Build **Shadow Trader (copy trading)**
2. 🌙 Research **dynamic risk parameters**
3. 🌙 Experiment **prediction markets integration**
4. 🌙 Explore **AI risk assistant** (data collection phase)

---

**The Big Idea:** Percolator isn't just another perp DEX. It's a **community-owned risk marketplace** where permissionless innovation meets sophisticated risk management. The moat isn't technology—it's network effects around market creators, liquidators, and traders who all have skin in the game.

**Hackathon Pitch:** "Drift is a bank. Percolator is a bazaar. In a bazaar, anyone can set up shop. The best merchants thrive. The community decides what's valuable. And everyone shares in the upside."
