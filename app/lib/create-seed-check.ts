/**
 * Create wizard: does the wallet hold the seed the launch takes? (Council r9 creator: seed 3,100 USDC, wallet 400,
 * HOLD TO LAUNCH was on and said nothing.) The wallet's collateral balance is read in the pre-flight; HOLD stays off
 * until it covers the seed. A balance that could not be read is not "enough": it says so and offers a retry.
 */

export type SeedCheck =
  | { kind: "ok" }
  | { kind: "checking" }
  | { kind: "unknown" }
  | { kind: "short"; haveAtoms: bigint; needAtoms: bigint };

export function checkSeedBalance(args: {
  /** null = not read yet. */
  balanceAtoms: bigint | null;
  /** The read failed (not "the token account does not exist", which is a real zero). */
  readFailed: boolean;
  needAtoms: bigint;
}): SeedCheck {
  if (args.readFailed) return { kind: "unknown" };
  if (args.balanceAtoms === null) return { kind: "checking" };
  return args.balanceAtoms >= args.needAtoms
    ? { kind: "ok" }
    : { kind: "short", haveAtoms: args.balanceAtoms, needAtoms: args.needAtoms };
}

const fmt = (atoms: bigint, decimals: number): string => {
  const n = Number(atoms) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};

/** Plain one-line reason for a check that blocks the launch (null when it does not). */
export function seedCheckMessage(check: SeedCheck, symbol: string, decimals: number): string | null {
  switch (check.kind) {
    case "ok":
      return null;
    case "checking":
      return "Checking your wallet balance…";
    case "unknown":
      return "Could not read your wallet balance. Try again.";
    case "short":
      return `You need ${fmt(check.needAtoms, decimals)} ${symbol} to seed this market; your wallet has ${fmt(check.haveAtoms, decimals)}.`;
  }
}
