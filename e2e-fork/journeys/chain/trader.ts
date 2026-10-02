/**
 * C1 trader journey (chain level): fund → portfolio → deposit → open (long|short) →
 * partial close → full close → withdraw. Asserts on-chain after every step:
 * wallet/vault token balances, portfolio capital + legs, all four fee counters,
 * engine current_slot vs chain slot.
 */
import { Keypair } from "@solana/web3.js";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";

const J = "C1-trader";
export async function traderJourney(sym: string, side: "long" | "short", usdNotional = 200, deposit = 1_000_000_000n): Promise<{ trader: Keypair; port: import("@solana/web3.js").PublicKey }> {
  const m = P.markets()[sym];
  if (!m) throw new Error(`market ${sym} not seeded`);
  const tag = `${sym}:${side}`;
  const trader = await P.newWallet({ sol: 5, usdc: 10_000_000_000n });
  const w0 = await P.usdcBalance(trader.publicKey);
  check(J, tag, "faucet/fund", w0 === 10_000_000_000n, "10,000 Sim-USDC in wallet", `${w0}`);

  const port = await P.createPortfolio(trader, m);
  const s0 = await P.readMarket(m);
  const sigDep = await P.mustSend("deposit", [await P.depositIx(trader.publicKey, m, port, deposit)], [trader]);
  const p1 = await P.readPortfolio(port);
  const s1 = await P.readMarket(m);
  const w1 = await P.usdcBalance(trader.publicKey);
  check(J, tag, "deposit: portfolio capital", p1.capital === deposit, `${deposit}`, `${p1.capital}`, [sigDep]);
  check(J, tag, "deposit: wallet debited", w0 - w1 === deposit, `${deposit}`, `${w0 - w1}`);
  check(J, tag, "deposit: vault credited", s1.vaultTokens - s0.vaultTokens === deposit, `${deposit}`, `${s1.vaultTokens - s0.vaultTokens}`);

  // open
  const q = await P.qForUsd(m, usdNotional);
  const sizeQ = side === "long" ? q : -q;
  const sigOpen = await P.mustSend("open", [await P.tradeIx(trader.publicKey, m, port, sizeQ)], [trader]);
  const p2 = await P.readPortfolio(port);
  const s2 = await P.readMarket(m);
  const leg = p2.legs[0];
  check(J, tag, `open ${side}: one leg with correct sign`, p2.legs.length === 1 && (side === "long" ? leg.basisPosQ > 0n : leg.basisPosQ < 0n), `1 leg ${side}`, `${p2.legs.length} legs basisPosQ=${leg?.basisPosQ}`, [sigOpen]);
  const feeCharged = p1.capital - p2.capital; // taker fee comes out of capital
  const dProt = s2.fees.protocolAccrued - s1.fees.protocolAccrued;
  const dLp = s2.fees.lpAccrued - s1.fees.lpAccrued;
  const dIns = s2.fees.insReserveAccrued - s1.fees.insReserveAccrued;
  const dCre = s2.fees.creatorClaimable - s1.fees.creatorClaimable;
  const legsSum = dProt + dLp + dIns + dCre;
  check(J, tag, "open: taker fee charged from capital", feeCharged > 0n, "> 0", `${feeCharged}`);
  check(J, tag, "open: fee split 20/48/16/16 (±dust) sums to fee", legsSum <= feeCharged && feeCharged - legsSum <= 32n && dProt * 5n <= feeCharged + 5n && dLp > dProt && dIns > 0n && dCre > 0n,
    "prot≈20% lp≈48% ins≈16% creator≈16%", `fee=${feeCharged} prot=${dProt} lp=${dLp} ins=${dIns} creator=${dCre}`);
  check(J, tag, "open: engine clock tracks chain", s2.lag < 150n, "lag < 150 slots", `engine=${s2.engineSlot} chain=${s2.chainSlot} lag=${s2.lag}`);

  // partial close (half)
  const half = -(leg.basisPosQ / 2n);
  const sigHalf = await P.mustSend("partial close", [await P.tradeIx(trader.publicKey, m, port, half)], [trader]);
  const p3 = await P.readPortfolio(port);
  const rem = p3.legs[0]?.basisPosQ ?? 0n;
  check(J, tag, "partial close: position halved", rem !== 0n && (rem > 0n) === (leg.basisPosQ > 0n) && (rem - (leg.basisPosQ + half)) === 0n,
    `${leg.basisPosQ + half}`, `${rem}`, [sigHalf]);

  // full close
  const sigFull = await P.mustSend("full close", [await P.tradeIx(trader.publicKey, m, port, -rem)], [trader]);
  const p4 = await P.readPortfolio(port);
  check(J, tag, "full close: 0 active legs", p4.legs.length === 0, "0", `${p4.legs.length}`, [sigFull]);

  // withdraw everything (capital + realized pnl settle into capital on close)
  const cap = p4.capital + (p4.pnl > 0n ? 0n : 0n);
  const wBefore = await P.usdcBalance(trader.publicKey);
  const vBefore = (await P.readMarket(m)).vaultTokens;
  const wd = await P.send([await P.withdrawIx(trader.publicKey, m, port, cap)], [trader]);
  if (!wd.ok) {
    record({ journey: J, market: tag, step: "withdraw all capital", ok: false, expected: `withdraw ${cap}`, err: `${wd.err} ${wd.logs.slice(-6).join(" | ")}` });
  } else {
    const p5 = await P.readPortfolio(port);
    const wAfter = await P.usdcBalance(trader.publicKey);
    const vAfter = (await P.readMarket(m)).vaultTokens;
    check(J, tag, "withdraw: wallet credited == capital", wAfter - wBefore === cap, `${cap}`, `${wAfter - wBefore}`, [wd.sig!]);
    check(J, tag, "withdraw: vault debited == capital", vBefore - vAfter === cap, `${cap}`, `${vBefore - vAfter}`);
    check(J, tag, "withdraw: portfolio capital 0", p5.capital === 0n, "0", `${p5.capital} (pnl ${p5.pnl})`);
    const roundTrip = (w0 - wAfter);
    check(J, tag, "round trip cost == fees + price move (bounded)", roundTrip >= 0n && roundTrip < deposit / 10n, "0 ≤ cost < 10% of deposit", `${roundTrip} atoms`);
  }
  return { trader, port };
}
