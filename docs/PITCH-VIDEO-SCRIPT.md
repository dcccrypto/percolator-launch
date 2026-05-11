# Pitch / Demo Video Script

**Length target:** 90 seconds (Colosseum Frontier hard cap is 3 minutes — we run shorter to respect judges' time)
**Voiceover:** Khubair, co-founder
**Format:** Founder on-camera intro and outro, screen-recording demo for the middle
**Tone:** Conversational, first-person, no marketing-speak, no triplet lists. If you stumble, leave it in — judges trust voices that sound real, not voices that sound rehearsed.

---

## Run sheet

```
00:00–00:08  ON CAMERA  Intro
00:08–00:30  SCREEN     Problem  →  Hero stat / waitlist / market list
00:30–01:00  SCREEN     Demo flow  →  Launch market, deposit, trade, close
01:00–01:25  SCREEN     Why it works  →  Toly origin, Kani proofs, LP model
01:25–01:35  SCREEN     Traction  →  220 markets, 100+ creators, waitlist
01:35–01:45  ON CAMERA  Close
```

---

## Full VO script (target ~280 words, ~95 seconds at conversational pace)

### [00:00 — ON CAMERA, Khubair]

> Hey, I'm Khubair. I'm one of the founders of Percolator. We're permissionless perpetual futures on Solana.

### [00:08 — SCREEN: mainnet closed beta home, market list]

> Look, Solana has over 15 million SPL tokens. Only about fifty have a perp market. Jupiter, Drift, Pacifica — they all curate. Hyperliquid lets anyone deploy a perp DEX through HIP-3, but you need to stake 500 thousand HYPE. That's around 20 million dollars.
>
> So 15 million tokens have no perp access. That's the gap we open.

### [00:30 — SCREEN: launch-market flow, fields visible, submit]

> Anyone launches a perp market on any SPL token in about 60 seconds. No team approval, no auction, no stake.

### [00:38 — SCREEN: trade flow — connect wallet → deposit USDC → open long → close at PnL]

> Connect a wallet, deposit USDC, open leverage, close at PnL. Fees split four ways on-chain in the same transaction.

### [00:55 — SCREEN: position NFT visible in wallet]

> The position itself is a Token-2022 NFT. First transferable perp position on Solana.

### [01:02 — SCREEN: Toly's repo or one of the four Toly tweets]

> The math isn't ours. Anatoly Yakovenko wrote the H plus A-over-K risk engine and open-sourced a reference program. We forked it and built the product on top: the trading app, the keepers, the SDK, the frontend, plus 500-plus Kani formal proofs.

### [01:15 — SCREEN: Kani comparison "0 / 0 / 0 / 500+" from the deck]

> Hyperliquid, Drift, Jupiter — zero formal proofs between them.

### [01:20 — SCREEN: revenue / business model split visual]

> And we don't need market makers, because the LP vault is the counterparty on every trade. Same model as Jupiter's JLP, which did 264 billion in volume last year. No microstructure dependency, no maker bootstrap problem.

### [01:35 — SCREEN: traction slide or short montage]

> A hundred-plus creators have already seeded LP vaults across 220 markets on devnet. We just shipped to mainnet closed beta. The waitlist crossed 100 signups in the first 48 hours.

### [01:50 — ON CAMERA, Khubair, eye contact]

> Public mainnet opens once the audit clears. Thanks for watching.

---

## Alternate openings (pick whichever feels least rehearsed on the day)

**Plain (current):**
> Hey, I'm Khubair. I'm one of the founders of Percolator.

**Stakes-led:**
> Solana has 15 million SPL tokens. Fifty of them have a perp market. I'm Khubair, and Percolator is how the other 15 million get one.

**Personal:**
> I'm Khubair. My co-founder and I have both won bounties on Percolator from Toly. So when we started building the product layer around his risk engine, we already knew the codebase.

---

## Alternate closings

**Current:**
> Public mainnet opens once the audit clears. Thanks for watching.

**With Call to Action:**
> The closed beta is live at mainnet.percolatorlaunch.com. Public mainnet opens after the audit. Thanks for watching.

**With waitlist push:**
> If you want a heads up when public mainnet opens, the waitlist is at percolator.trade. Thanks for watching.

---

## What NOT to say (set by prior feedback)

- "Pump.fun for perps" — drop entirely, no pump.fun mentions
- "We built the whole thing" — Toly built the risk engine; we built the product layer around it. Give him credit.
- "Perp launcher" — we're not just a launcher; we're a permissionless perp DEX
- "Revolutionary / disruptive / game-changing" — none of that
- "We charge X for Y" without follow-through — be specific about the fee split
- Em dashes when you can use a comma or a period instead — they read as written-not-spoken

---

## What you need before recording

**Hardware:**
- Decent camera (phone is fine if held steady — use a tripod)
- External mic (lavalier or USB condenser; built-in laptop mics sound thin)
- Lighting on your face, not from behind you

**Screen-recording prep:**
- Mainnet closed-beta site loaded and logged in with a wallet that has USDC
- Pick ONE market to demo (SOL/USDC Hyperp is the obvious one)
- Do a dry run of the trade flow first — find the cleanest path through the UI
- Have the Toly tweet screenshots / pitch deck slides queued in browser tabs for the cutaways

**B-roll / cutaways:**
- mainnet.percolatorlaunch.com/pitch slides 6 (Kani comparison), 5 (Traction), 4 (Toly Signal)
- Solana Explorer page for the mainnet program ID `ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv` (proof of deployment)
- Github org page github.com/dcccrypto (proof of repo count + Apache 2.0)

---

## Recording tips

- **Show, don't describe.** When you say "open leverage, close at PnL," the wallet should already be open and the trade already in motion. Cap's rule: product on screen before the 60-second mark.
- **One take through, fix in edit.** Don't try to nail every line on the first try — record the whole script three times, splice the best of each. CapCut or Premiere will get you there in an evening.
- **Background sound matters.** Quiet room. Curtains. No HVAC running. No notifications on the recording machine.
- **Watch the pace.** This script reads at ~170 words per minute. If you naturally talk faster, you'll come in under 90 seconds — that's fine, gives breathing room. If you talk slower, drop the alternate-closing version with the CTA and keep just the bare one.

---

## Post-record checklist

- [ ] Hosted somewhere stable: YouTube unlisted is fine, or a direct Vercel/CDN drop
- [ ] Linked on the Demo Product slide of the deployed pitch deck (currently missing — once the video is up, edit slide 7 to embed it)
- [ ] Linked in the Colosseum submission form
- [ ] Tweet announcement from `@percolatortrade` once it's live (visibility to judges)
