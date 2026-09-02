/**
 * The message a market deployer signs to authorize
 * `POST /api/playground/keeper-register`.
 *
 * #2505 / #2468: the H1v2 "stateless deployer proof" replaced an earlier
 * nonce+challenge scheme to remove a serverless race — correctly. But in dropping
 * the nonce it also dropped PAYLOAD BINDING, and the message became:
 *
 *     keeper-register:<slabAddress>:<unix-minute>
 *
 * That authorizes the SLAB and nothing else. It says nothing about the pool being
 * registered, the mainnet CA, the dex type, or the label — so one captured
 * signature authorized registering that slab against ANY pool (#2468), and the
 * request's actual parameters were never covered by the thing verifying them
 * (#2505).
 *
 * The sibling route `POST /api/markets` already binds a domain-separated message
 * over its complete canonical payload (`lib/market-registration-auth.ts`). This
 * brings keeper-register to the same standard, minus the nonce.
 *
 * WHAT THIS DELIBERATELY DOES NOT FIX: the signature remains valid across the
 * ~6-minute tolerance window and is not single-use. Closing that needs a
 * server-side nonce store — which is exactly what H1v2 removed to fix the
 * serverless race, so reintroducing it here would trade a replay window for a
 * correctness bug.
 *
 * Payload binding shrinks the CONSEQUENCE rather than the window: a captured
 * signature can now only replay the SAME registration, which is idempotent,
 * instead of authorizing a substituted pool.
 *
 * Shared by the client (`hooks/useCreateMarket.ts`) and the route so the two
 * cannot drift. Drift fails closed — the signature simply will not verify — but
 * it fails closed at market-creation time, which is a bad moment to find out.
 */

export const KEEPER_REGISTER_PROOF_PREFIX = "keeper-register";

/**
 * Field separator: ASCII Unit Separator (0x1F).
 *
 * Written as an escape rather than a literal so the source stays printable. It
 * cannot occur in a base58 address, a token symbol, or a human label typed into
 * the wizard, so no field's content can imitate the delimiter and shift another
 * field's meaning — the canonicalisation is unambiguous.
 */
const FIELD_SEP = "\u001F";

/** The registration parameters the route acts on, and therefore must be signed. */
export interface KeeperRegisterProofParams {
  slabAddress: string;
  dexPoolAddress: string;
  mainnetCA: string;
  dexType: string;
  symbol?: string;
  label?: string;
}

/**
 * Canonical, order-independent encoding of the bound parameters.
 *
 * Keys are sorted so the client and the route cannot disagree by object-literal
 * order. Absent optionals encode as EMPTY rather than being omitted, so "no
 * symbol" and "symbol removed" produce the same message and cannot be swapped
 * for one another — omitting them would let two different requests share a
 * signature.
 */
export function canonicalizeKeeperRegisterParams(
  p: KeeperRegisterProofParams,
): string {
  const fields: Record<string, string> = {
    dexPoolAddress: p.dexPoolAddress ?? "",
    dexType: p.dexType ?? "",
    label: p.label ?? "",
    mainnetCA: p.mainnetCA ?? "",
    slabAddress: p.slabAddress ?? "",
    symbol: p.symbol ?? "",
  };
  return Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join(FIELD_SEP);
}

/**
 * Build the exact bytes to sign / verify.
 *
 * `Uint8Array.from` rather than the TextEncoder's own result: TweetNaCl does a
 * strict `instanceof Uint8Array` check, and an encoder can return an array from
 * another JS realm in some test and browser environments. The sibling auth module
 * hit exactly this and documents it; same defence here.
 */
export function buildKeeperRegisterProofMessage(
  p: KeeperRegisterProofParams,
  unixMinute: number,
): Uint8Array {
  const message = [
    KEEPER_REGISTER_PROOF_PREFIX,
    String(unixMinute),
    canonicalizeKeeperRegisterParams(p),
  ].join("\n");
  return Uint8Array.from(new TextEncoder().encode(message));
}
