# PnL share-card backgrounds

Full card artwork for the live PnL share card. There are two tone-matched sets —
the card shows the profit set on a gain and the loss set on a loss, so a red PnL
never sits on "I made money" art. (Only the scene is rate-limited: it flips at most
once per 1.2 s so a breakeven PnL can't strobe it. The PnL, %, PROFIT/LOSS/BREAKEVEN
label and colour always follow the live sign immediately.)

```
profit:  bg-1.png  bg-2.png  bg-3.png  bg-4.png  bg-5.png
loss:    negpnl-1.jpg  negpnl-2.jpg  negpnl-3.jpg
```

(The lists live in `app/lib/pnl-card.ts` → `PNL_CARD_BACKGROUNDS_PROFIT` /
`PNL_CARD_BACKGROUNDS_LOSS`, selected by `pnlCardBackgrounds(isProfit)`; add/rename
there to change the count. The viewer can cycle within the current set.)

Each image is the **complete card art** — character + neon frame + an **empty dark
stats panel** along the bottom. The app overlays the live data on top:

- logo / name / $ticker, PROFIT|LOSS, the big PnL and the % badge → **upper-left**;
- Spent / Average entry / Average exit → inside the **bottom panel**;
- "PERCOLATOR TRADE · DEVNET V2" → under the panel.

So the art should include everything **except the data numbers** (no baked-in
"+$378.96" / Spent / Entry values — those are drawn live).

Guidelines:

- **Square 1:1** (≈ **1200×1200**). Square shares best on X. Non-square art is
  object-cover cropped to the square, which trims the side frame — keep them square.
  (`bg-1.png` is currently landscape; re-export it square when convenient.)
- Keep the **upper-left ~55% relatively clear** (the card adds a soft scrim + text
  shadows, but busy art there fights the text) and leave the **bottom panel empty**.

Missing/404 images fall back to a purple gradient per-slot; everything else still works.
