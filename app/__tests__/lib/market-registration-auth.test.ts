import nacl from "tweetnacl";
import {
  buildMarketRegistrationMessage,
  canonicalizeMarketRegistrationPayload,
  MARKET_REGISTRATION_AUTH_DOMAIN,
  MARKET_REGISTRATION_AUTH_METHOD,
  MARKET_REGISTRATION_AUTH_PATH,
  type MarketRegistrationPayload,
} from "@/lib/market-registration-auth";
import {
  describe,
  expect,
  it,
} from "vitest";

const NONCE =
  "550e8400-e29b-41d4-a716-446655440000";

const DEPLOYER =
  "11111111111111111111111111111111";

function buildPayload(
  overrides:
    MarketRegistrationPayload = {},
): MarketRegistrationPayload {
  return {
    slab_address:
      "7eubYRwJiQdJgXsw1VdaNQ7YHvHbgChe7wbPNQw74S23",
    mint_address:
      "So11111111111111111111111111111111111111112",
    deployer: DEPLOYER,
    symbol: "TEST-PERP",
    name: "Test Market",
    decimals: 6,
    oracle_mode: "admin",
    oracle_authority: DEPLOYER,
    dex_pool_address: null,
    mainnet_ca: null,
    initial_price_e6: "1000000",
    max_leverage: 5,
    trading_fee_bps: 10,
    logo_url: null,
    ...overrides,
  };
}

describe(
  "market registration authorization",
  () => {
    it(
      "is deterministic regardless of object insertion order",
      () => {
        const first = buildPayload();

        const reversed =
          Object.fromEntries(
            Object.entries(first).reverse(),
          );

        expect(
          canonicalizeMarketRegistrationPayload(
            reversed,
          ),
        ).toBe(
          canonicalizeMarketRegistrationPayload(
            first,
          ),
        );
      },
    );

    it(
      "excludes only nonce and signature from the request envelope",
      () => {
        const original = buildPayload();

        expect(
          canonicalizeMarketRegistrationPayload({
            ...original,
            nonce: NONCE,
            signature: "base64-signature",
          }),
        ).toBe(
          canonicalizeMarketRegistrationPayload(
            original,
          ),
        );
      },
    );

    it(
      "includes domain, method, route, nonce, deployer and payload",
      () => {
        const message =
          buildMarketRegistrationMessage({
            nonce: NONCE,
            deployer: DEPLOYER,
            payload: buildPayload(),
          });

        const decoded =
          new TextDecoder().decode(message);

        expect(decoded).toContain(
          `${MARKET_REGISTRATION_AUTH_DOMAIN}\n`,
        );

        expect(decoded).toContain(
          `\n${MARKET_REGISTRATION_AUTH_METHOD}\n`,
        );

        expect(decoded).toContain(
          `\n${MARKET_REGISTRATION_AUTH_PATH}\n`,
        );

        expect(decoded).toContain(
          `\n${NONCE}\n${DEPLOYER}\n`,
        );

        expect(decoded).toContain(
          '"symbol":"TEST-PERP"',
        );
      },
    );

    it.each([
      ["symbol", "ALTERED-PERP"],
      ["name", "Altered Market"],
      ["oracle_mode", "keeper"],
      [
        "oracle_authority",
        "So11111111111111111111111111111111111111112",
      ],
      [
        "dex_pool_address",
        "So11111111111111111111111111111111111111112",
      ],
      [
        "mainnet_ca",
        "So11111111111111111111111111111111111111112",
      ],
      ["initial_price_e6", "999000000"],
      ["max_leverage", 99],
      ["trading_fee_bps", 999],
      [
        "logo_url",
        "https://example.invalid/logo.png",
      ],
    ])(
      "changing %s changes the signed message",
      (field, replacement) => {
        const original =
          buildMarketRegistrationMessage({
            nonce: NONCE,
            deployer: DEPLOYER,
            payload: buildPayload(),
          });

        const modified =
          buildMarketRegistrationMessage({
            nonce: NONCE,
            deployer: DEPLOYER,
            payload: buildPayload({
              [field]: replacement,
            }),
          });

        expect(modified).not.toEqual(
          original,
        );
      },
    );

    it(
      "returns bytes accepted directly by TweetNaCl",
      () => {
        const keyPair =
          nacl.sign.keyPair();

        const message =
          buildMarketRegistrationMessage({
            nonce: NONCE,
            deployer: DEPLOYER,
            payload: buildPayload(),
          });

        expect(
          message,
        ).toBeInstanceOf(Uint8Array);

        expect(() =>
          nacl.sign.detached(
            message,
            keyPair.secretKey,
          ),
        ).not.toThrow();
      },
    );

    it(
      "rejects mismatched envelope and payload deployers",
      () => {
        expect(() =>
          buildMarketRegistrationMessage({
            nonce: NONCE,
            deployer: DEPLOYER,
            payload: buildPayload({
              deployer:
                "So11111111111111111111111111111111111111112",
            }),
          }),
        ).toThrow(/deployer/i);
      },
    );
  },
);
