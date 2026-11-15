/** USD price per TOKEN from the per-lot USD price (a float, for display / typed-size maths). Identity at lotExp = 0. */
export function tokenUsdOfLotUsd(perLotUsd: number, lotExp: number): number {
  return lotExp === 0 ? perLotUsd : perLotUsd / 10 ** lotExp;
}
