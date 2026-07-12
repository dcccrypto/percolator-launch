import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hookSource = readFileSync(
  resolve(process.cwd(), "hooks/useCreateMarket.ts"),
  "utf8",
);

const functionStart = hookSource.indexOf(
  "async function attemptFreshBatchedLaunch",
);
const functionEnd = hookSource.indexOf(
  "\nconst STEP_LABELS",
  functionStart,
);

describe("useCreateMarket fresh batched registration", () => {
  it("signs the canonical registration payload and posts that same payload", () => {
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const freshBatchSource = hookSource.slice(functionStart, functionEnd);

    expect(freshBatchSource).toMatch(
      /const registrationPayload:\s*MarketRegistrationPayload\s*=\s*\{/,
    );

    expect(freshBatchSource).toContain(
      "const deployerStr: string = walletPk.toBase58();",
    );

    expect(freshBatchSource).toMatch(
      /buildMarketRegistrationMessage\(\{\s*nonce:\s*marketsNonce,\s*deployer:\s*deployerStr,\s*payload:\s*registrationPayload,\s*\}\)/s,
    );

    expect(freshBatchSource).toContain(
      "wallet.signMessage(signingMessage)",
    );

    expect(freshBatchSource).not.toContain(
      "new TextEncoder().encode(marketsNonce)",
    );

    const registrationStart = freshBatchSource.indexOf(
      "const marketsRegisterPromise",
    );
    const registrationEnd = freshBatchSource.indexOf(
      "const keeperRegisterPromise",
      registrationStart,
    );

    expect(registrationStart).toBeGreaterThanOrEqual(0);
    expect(registrationEnd).toBeGreaterThan(registrationStart);

    const registrationRequestSource = freshBatchSource.slice(
      registrationStart,
      registrationEnd,
    );

    expect(registrationRequestSource).toMatch(
      /body:\s*JSON\.stringify\(\{\s*\.\.\.registrationPayload,/s,
    );

    expect(registrationRequestSource).toMatch(
      /\.\.\.\(marketsNonce\s*&&\s*marketsSignature\s*\?\s*\{\s*nonce:\s*marketsNonce,\s*signature:\s*marketsSignature\s*\}/s,
    );

    // Prevent the POST body from drifting back to a separately duplicated
    // market-registration object.
    expect(registrationRequestSource).not.toMatch(/\bslab_address\s*:/);
    expect(registrationRequestSource).not.toMatch(/\bmint_address\s*:/);
    expect(registrationRequestSource).not.toMatch(/\bdeployer\s*:/);
  });
});
