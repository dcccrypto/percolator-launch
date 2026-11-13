// @vitest-environment node
/**
 * Binds the #2629 keep-on-unknown fix to the source.
 *
 * /api/devnet-airdrop used its own local sendAndConfirmSignedTx, which threw a
 * GENERIC error on poll-timeout — indistinguishable from a real failure — and the
 * `finally` released the 24h claim on any !mintSucceeded, so a slow-but-landed mint
 * let a retry double-airdrop. The sibling routes (devnet-pre-fund #2599,
 * playground/faucet #2602) distinguish a definite failure (release the claim) from
 * an unknown/timeout outcome (KEEP it) via ServerSignatureTimeoutError.
 *
 * A behavioural test would have to drive the route's local confirm through its
 * hardcoded 45s timeout (un-mockable without a refactor), so this asserts on the
 * WIRING — the same reason create-market-price-gate.test.ts reads source. The
 * behaviour of the shared keep-on-timeout path itself is covered by
 * devnet-pre-fund-claim-release.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../app/api/devnet-airdrop/route.ts"),
  "utf8",
);

/** Drop comments, so an assertion about CODE is not satisfied by prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#2629 devnet-airdrop keeps the claim on an unknown outcome", () => {
  it("the local confirm throws the typed timeout error, not a generic Error", () => {
    const c = code(SRC);
    expect(c).toContain("throw new ServerSignatureTimeoutError(sig, timeoutMs)");
    // the old generic timeout throw must be gone
    expect(c).not.toMatch(/throw new Error\(`Transaction \$\{sig\} not confirmed/);
  });

  it("an unknown outcome flags the mint so the finally KEEPS the claim", () => {
    const c = code(SRC);
    expect(c).toMatch(/if \(mintErr instanceof ServerSignatureTimeoutError\) \{\s*mintOutcomeUnknown = true/);
    // release is now gated on NOT-unknown as well as not-succeeded
    expect(c).toContain("!mintSucceeded && !mintOutcomeUnknown");
  });

  it("an ambiguous send is resolved by the pre-send signature (a36b3c87 rule)", () => {
    const c = code(SRC);
    expect(c).toContain("bs58.encode(signedTx.signature)");
    // only a JSON-RPC rejection means not-broadcast; anything else is unknown
    expect(c).toMatch(/!\(sendErr instanceof SendTransactionError\) && preSendSig/);
    expect(c).toContain("throw new ServerSignatureTimeoutError(preSendSig, timeoutMs)");
  });

  it("an unknown outcome answers 503 pending, retryable:false, with the signature", () => {
    const c = code(SRC);
    expect(c).toMatch(/pending: true,\s*retryable: false,\s*signature: mintErr\.signature/);
  });
});
