/**
 * Payload-bound authorization for POST /api/markets.
 *
 * The browser client and server must build exactly the same
 * domain-separated message from the challenge nonce and complete
 * registration payload.
 */

export const MARKET_REGISTRATION_AUTH_DOMAIN =
  "percolator-launch:markets:create:v1";

export const MARKET_REGISTRATION_AUTH_METHOD =
  "POST";

export const MARKET_REGISTRATION_AUTH_PATH =
  "/api/markets";

export type MarketRegistrationPayload =
  Record<string, unknown>;

export interface MarketRegistrationAuthorization {
  nonce: string;
  deployer: string;
  payload: MarketRegistrationPayload;
}

const AUTHENTICATION_FIELDS = new Set([
  "nonce",
  "signature",
]);

/**
 * Deterministic JSON encoding.
 *
 * Object keys are sorted lexicographically. Undefined object
 * properties are omitted, while undefined array entries become null,
 * matching JSON.stringify behavior.
 */
function encodeCanonicalJson(
  value: unknown,
  arrayEntry = false,
): string | undefined {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? JSON.stringify(value)
      : "null";
  }

  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return arrayEntry ? "null" : undefined;
  }

  if (typeof value === "bigint") {
    throw new TypeError(
      "BigInt is not supported in market registration payloads",
    );
  }

  if (Array.isArray(value)) {
    const entries = value.map(
      (entry) =>
        encodeCanonicalJson(entry, true) ?? "null",
    );

    return `[${entries.join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError(
        "Market registration payload must contain plain JSON objects",
      );
    }

    const record =
      value as Record<string, unknown>;

    const entries: string[] = [];

    for (const key of Object.keys(record).sort()) {
      const encoded =
        encodeCanonicalJson(record[key]);

      if (encoded === undefined) {
        continue;
      }

      entries.push(
        `${JSON.stringify(key)}:${encoded}`,
      );
    }

    return `{${entries.join(",")}}`;
  }

  throw new TypeError(
    "Unsupported market registration payload value",
  );
}

/**
 * Remove authentication-envelope fields before canonicalization.
 *
 * The client signs the registration object before nonce/signature are
 * appended. The server receives them in the same JSON request, so only
 * these envelope fields are excluded.
 */
export function canonicalizeMarketRegistrationPayload(
  payload: MarketRegistrationPayload,
): string {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new TypeError(
      "Market registration payload must be an object",
    );
  }

  const registrationPayload:
    MarketRegistrationPayload = {};

  for (const [key, value] of Object.entries(
    payload,
  )) {
    if (AUTHENTICATION_FIELDS.has(key)) {
      continue;
    }

    registrationPayload[key] = value;
  }

  const canonical =
    encodeCanonicalJson(registrationPayload);

  if (canonical === undefined) {
    throw new TypeError(
      "Unable to canonicalize market registration payload",
    );
  }

  return canonical;
}

/**
 * Signing message:
 *
 * percolator-launch:markets:create:v1
 * POST
 * /api/markets
 * <nonce>
 * <deployer>
 * <canonical registration JSON>
 */
export function buildMarketRegistrationMessage(
  authorization: MarketRegistrationAuthorization,
): Uint8Array {
  const {
    nonce,
    deployer,
    payload,
  } = authorization;

  if (!nonce || !deployer) {
    throw new Error(
      "Market registration nonce and deployer are required",
    );
  }

  if (payload.deployer !== deployer) {
    throw new Error(
      "Market registration payload deployer does not match authorization deployer",
    );
  }

  const canonicalPayload =
    canonicalizeMarketRegistrationPayload(
      payload,
    );

  const message = [
    MARKET_REGISTRATION_AUTH_DOMAIN,
    MARKET_REGISTRATION_AUTH_METHOD,
    MARKET_REGISTRATION_AUTH_PATH,
    nonce,
    deployer,
    canonicalPayload,
  ].join("\n");

  /*
   * TextEncoder can return a Uint8Array associated with another
   * JavaScript realm in some test/browser environments. TweetNaCl
   * performs a strict instanceof Uint8Array check, so copy the encoded
   * bytes into the active runtime's Uint8Array constructor.
   */
  return Uint8Array.from(
    new TextEncoder().encode(message),
  );
}
