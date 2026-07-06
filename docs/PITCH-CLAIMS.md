# Pitch claims ledger

## Deck architecture (2026-06-13)

Slides + styling live ONCE in `app/app/pitch/_deck.tsx` (shared library:
`PitchDeck` runner + all `Slide*` components + CSS). Each audience deck is a thin
route that imports the shared slides and passes its own ordered `slides` array —
**fix a fact in `_deck.tsx` and every deck updates; no copy-paste drift.**

- `/pitch` — **VC** (14 slides). Spine: problem → fix → **Opportunity (long-tail
  business case)** → why now → competition → Toly → team → traction → economics.
  Uses `SlideMathVC` (plain-English "How it stays safe"), not the heavy
  `SlideMath`. Moat slide dropped (Competition carries defensibility). 2026-06-19
  editorial pass cut wordiness/AI-cadence and softened tech jargon.
- `/pitch/technical` — **engineers / Toly-grade DD** (10 slides; engine + math
  early; drops Why Now, Business Model, Moat, GTM)
- `/pitch/grants` — **Solana Foundation / Superteam** (9 slides; open-source +
  ecosystem-contribution story; drops Business Model, Moat, Competition, Why Now)
- `/pitch/intro` — **short intro/teaser deck** (8 slides, minimal words, one
  bold statement per slide, built for a cold async read). Own lean slide
  components, reuses the shared PitchDeck runner + CSS. The ask states the
  milestone, not a number (fill before sending).
- `/pitch-2` — legacy Colosseum cut, NOT on the shared library yet (still a
  copy-paste file; Frontier ended May 11, retire or migrate).

When editing slide copy, edit `_deck.tsx` only. The per-audience route files
change order/selection, never slide text.



Every load-bearing claim in `/pitch` (14 slides) and `/pitch-2` (10-slide Colosseum
variant), its status, and how to re-verify it. **Update this file with every deck
edit; diff against it instead of re-auditing from scratch.**

Statuses: **SHIPPED** (true in deployed code today) · **VERIFIED** (externally
checked, with date) · **GATED** (true at mainnet V1 or at permissionless open,
stated that way in the deck) · **TARGET** (forward-looking, stated as a target).

Last full verification pass: **2026-06-11** (on-chain census, engine proof count,
4 web research sweeps, adversarial-validation cross-check).

## Our own numbers

| Claim | Status | Evidence / how to re-check |
|---|---|---|
| 220 devnet markets, 71 unique creators, 72 small / 12 med / 136 large | VERIFIED 2026-06-11 | Magic-byte slab census via `getProgramAccounts` across the 3 slab-tier devnet programs |
| 420 Kani proof harnesses | VERIFIED 2026-06-11 | `grep -rc '#\[kani::proof\]' tests/proofs_*.rs` on the current engine branch (`~/percolator`). Re-count on every engine sync; this number has drifted 3× before |
| 22 public repos | VERIFIED 2026-06-11 | `gh repo list dcccrypto --visibility public --json name -q '.[].name' \| grep -ci percolator` |
| 51 fork-only instructions, 4 programs on mainnet | VERIFIED 2026-06-11 | Commit f36b673c re-verification |
| 8,000+ verified waitlist signups (LIVE-WIRED), 4,500+ bots purged | AUTO since 2026-06-11 | Deck fetches `/api/waitlist/count` (Supabase `waitlist_count` RPC, verified post-purge signups; 8,033 at wiring time), rounded down to the nearest hundred, fallback 8,000. No manual updates needed. Waitlist opened ~2026-05-08 |
| 6,500+ organic X followers, $0 paid | VERIFIED 2026-06-11 | @percolatortrade |
| SOL/USDC market created on mainnet in May | VERIFIED | J51cB2 slab, program `ESa89R5…`. Do NOT say "first": an earlier lab market (`CDu48T84…`) existed Apr 20–25 and its tx history is public. Slab has no successful txs since May 12, so do not say "live today" either |
| ~$0.002 Solana compute per trade | VERIFIED 2026-05 | ~0.000009 SOL per fill on a real mainnet tx |
| ~60-second permissionless market creation | SHIPPED | Devnet flow |
| Transferable Token-2022 NFT positions | SHIPPED | Never say "first on Solana" (unverified) |
| Both founders won Toly bounties; 20+ public Toly engagements since Feb; "found and patched engine bugs, built our own stake program" | VERIFIED | Tweet screenshots in `/images/toly/`. Stake program = dcccrypto/percolator-stake (Toly RT'd it: "Look, a contribution! Don't trust, verify!"). Origin framing per his READMEs: "bad debt contained to the domain that caused it", fails closed, no oracle discretion. Tiles link to x.com/toly per user choice |

## Engine / risk claims (watch these — iterative work in flight)

| Claim | Status | Notes |
|---|---|---|
| Cross-market isolation (wipeout can't touch another market's vault) | SHIPPED | Solana account model, per-slab vaults |
| LP vault is the economic counterparty per trade | SHIPPED | `handle_trade_cpi`: engine opens bilateral position vs LP portfolio. Say "economic", not "mechanical" |
| Proportional haircut in the tail (`credit_rate_num`), NAV fails closed | SHIPPED | Haircut is silent on-chain; UI must surface `credit_rate_num` |
| Warmup-H gate on PnL extraction | SHIPPED | Containment, not prevention. Never say manipulation is "closed off"; deck says "capped payout, not an open vault" |
| Per-market insurance | SHIPPED-BY-POLICY | One `header.insurance` scalar per market group; isolation comes from the 1-group-per-market deployment convention. Don't claim "no shared insurance pool" as an absolute |
| Hard per-market OI caps | GATED | NOT in core engine today (`valid_liened_backing_num` unreachable; matcher `max_inventory_abs` defaults 0). Designed 2026-06-01; roadmap V1 item lists it ("proven on real flow before listings open up") |
| Per-market insurance sub-vaults | GATED | Designed (`market_insurance_{long,short}` PDAs), not shipped |
| Depth-gated marks + deviation clamps | GATED | CSV-FL+ v2 design, not shipped |
| Funding rates | GATED (unstated in deck) | Hard-disabled in deployed engine (`funding_rate_e9 != 0` rejected; `balanced_exposure` gate). Q&A landmine: answer is "skew-velocity funding ships at mainnet V1" |
| Four-way fee split at `CreateLpVault` | GATED | Deck labels it "at mainnet V1 (Q3–Q4 · post-audit)" — keep that label |
| Audit Q3; mainnet V1 (curated cohort) Q3–Q4 2026; permissionless listings 2027 | TARGET | Firm selection underway as of 2026-06-11. **V1 is deliberately curated** — permissionless is the protocol's native capability (live on devnet, 220 markets) and opens after V1 proves caps/funding/insurance on real flow. Don't claim permissionless mainnet listing at V1 |
| Fee level + splits: ILLUSTRATIVE ONLY (de-specified 2026-06-11) | TARGET | Deck no longer commits to numbers: BM title is fee-generic, the scenario table footnote labels 10 bps / ~tenth-to-protocol as "illustrative… still being tuned ahead of V1", the 30/20 creator split became "boosted/standard", the $1M/day MM threshold became "a sustained volume threshold", and the $50K-month/17-market break-even became "tens of markets". Exact fee + split are per-market at `CreateLpVault`. Don't reintroduce hard economics numbers until they're final |

## Competitive / market claims

| Claim | Status | Evidence (checked 2026-06-11) |
|---|---|---|
| Drift v3 drained $295M, Apr 1 2026, DPRK durable-nonce on admin multisig | VERIFIED | Final accounting ~$295.4M (CoinDesk 2026-05-05); $285M was the early estimate. It was **v3** (live since Dec 2025), not v2. Mandiant attribution: UNC6862 |
| Drift = largest Solana perp DEX by TVL pre-hack | VERIFIED | ~$550M TVL. By volume it was #2 behind Pacifica — say "largest by TVL" |
| Drift offline, relaunching as USDT-settled backed by Tether | VERIFIED, EXPIRES | ~$147.5M package, relaunch "before July 2026". Re-check before every presentation |
| Solana perp volume set records post-hack (first $20B week, May 2026) | VERIFIED | Driven partly by points-farming newcomers (GMTrade). Do NOT claim volume dropped after the hack — it didn't |
| Pacifica = volume leader, ~48 crypto markets | VERIFIED | ~48.5% of 24h volume (was 49.6% Q4 2025); GMTrade leads some windows. Don't print "51%" |
| Jupiter Perps: 3 markets (SOL/ETH/BTC), shared JLP, team-curated | VERIFIED | Jupiter docs |
| Hyperliquid: HIP-3 stake = 500K HYPE ≈ $28–30M (eight figures) | VERIFIED | HYPE ~$56–58 on 2026-06-11. HIP-3 DEXes run their own backstop (NOT shared HLP); core HL lists 100+ perps incl. memecoins |
| JELLY Mar 2025: ~$12M at risk, averted by validator delist + pinned oracle | VERIFIED | HLP netted +$700K; never say JELLY was "drained" or "taken" |
| Mango Oct 2022: $116M | VERIFIED | SEC figure; CFTC says $110M+ |
| Drift v1 May 2022: $14.5M | VERIFIED | Drift's own incident report (withdrawal bug + vAMM bank run) |
| Bulk: pre-mainnet, 9 curated markets, CLOB + cross-margin + shared insurance fund + ADL, permissionless = "BIP-1: Coming Soon" | VERIFIED 2026-06-11 | docs.bulk.trade + live API. $8M seed led by 6th Man + Robot Ventures (Wintermute; toly is an angel). ~$26M USDC Season-1 pre-deposits; site footer still says "Bulk Testnet". Re-check mainnet status before every presentation |
| Phoenix Perpetuals (Ellipsis): private beta, curated, ~0.5% share | VERIFIED | Removed from deck (too small to feature). Don't claim it absorbed Drift's volume |
| "Barely any Solana tokens have a perp" (number removed 2026-06-11) | VERIFIED as worded | The deck no longer prints a count because the union is an estimate (12–25 Solana-native tokens across live Solana venues with Drift offline; 25–35 pre-hack). If asked "how many exactly?": "roughly 15–25 depending on the day; we stopped quoting a number because venues churn listings weekly." Never revive "<50 anywhere" — it's FALSE (Hyperliquid alone lists ~28 Solana-native; CEX union 60–100+) |
| "Hundreds of SPL tokens with $50K+ daily spot volume and no perp anywhere" (the ~750 count removed 2026-06-11) | VERIFIED as worded | CoinGecko Solana-ecosystem backup if asked: 826 tokens ≥$50K/day minus ~50–100 with perps ≈ 700–780 unserved |
| SushiSwap 2020: pulled 55% of Uniswap's liquidity; Uniswap back above pre-attack peak within ~10 days of UNI, ~2.6× at six months | VERIFIED | DeFiLlama Uniswap v2 series |
| Solayer "Margin Trade" launched mainnet (another entrant) | NOTED, unused | The Block, June 2026. Candidate for Why Now if more entrants needed |

## Q&A landmines (not deck copy — be ready)

1. **Funding rates**: disabled in the deployed engine today; skew-velocity funding is program-upgrade work shipping at mainnet V1.
2. **LP vault sides**: one vault per group backs one side; the other side rests on insurance until the dual-domain vault lands.
3. **Tail haircut**: proportional and on-chain-readable, but currently silent; UI will surface `credit_rate_num`.
4. **Toly is a Bulk angel**: yes, one angel among many. Bulk is a CEX-style CLOB for majors with permissionless listing on a roadmap page; Percolator is the permissionless isolation engine whose math he wrote. His engagement here is technical (bounties, QTs of fixes).
5. **Cold-start depth** (GTM): the $50K-per-cohort treasury co-deposit claim was REMOVED 2026-06-11 (untrue; architecture still changing). The deck now says a guardrailed vAMM bootstrap layer (per-market caps + creator first-loss) is in design, shipping when permissionless listings open — that's the CSV-FL+ track. Never call it a bonding curve, and never market it as "non-rinsable" or "fully reserved" (per the design tournament's negative results).
6. **Slab rent recovery**: large-tier slab rent is real SOL; have the creator-economics math ready.
7. **"Demo it"**: devnet keeper/oracle state was down as of early May; verify markets actually trade before any live demo.
8. **"Your V1 is curated too — how are you different?"**: permissionless is the protocol's native capability and it's live on devnet (220 markets, 71 creators). V1 mainnet starts curated on purpose, to prove caps, funding, and insurance on real flow before open listings; incumbents are curated *forever* by architecture.
9. **Security posture** (risks box removed from Roadmap slide 2026-06-11; keep verbal): per-market LP isolation + warmup gate + pinned reference live today; hard OI caps, insurance sub-vaults, depth-gated marks, deviation clamps ship at V1; 4-of-7 Squads multisig at audit clearance, blind-signing simulation, hardware-only rotation.
