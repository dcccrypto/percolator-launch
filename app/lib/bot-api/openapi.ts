/**
 * OpenAPI 3.1 description of /api/v1, served at GET /api/v1/openapi.json. Hand-written, and kept honest by
 * __tests__/lib/bot-api/openapi.test.ts: every route directory has a path here and every path has a route; method, scope
 * and weight must equal what the route's botRoute() call says; every code in ERROR_CATALOG is listed.
 * Numbers that live in code (limits, caps, TTLs) are imported, not copied.
 */
import { API_VERSION, MAX_BODY_BYTES } from "./config";
import { ERROR_CATALOG, type ErrorCode } from "./errors";
import { TIER_BUDGET, GLOBAL_BUILD_BUDGET, GLOBAL_READ_BUDGET, PRINCIPAL_BUILD_CAP, WINDOW_SEC, AUTH_FAIL_LIMIT } from "./limits";
import { TTL_SEC } from "./idempotency";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, DEFAULT_MAX_NOTIONAL_USD, DEFAULT_MAX_LEVERAGE } from "./builders/caps";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./reads/history";
import { DEPTH_LADDER_USD } from "./reads/quote";
import { HEARTBEAT_MS, MAX_OPEN_STREAMS, MAX_STREAM_MS, SNAPSHOT_MS } from "./stream";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const ref = (name: string): Obj => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Obj = {}): Obj => ({ type: "string", ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: Obj = {}): Obj => ({ type: "integer", ...(description ? { description } : {}), ...extra });
const num = (description?: string): Obj => ({ type: "number", ...(description ? { description } : {}) });
const bool = (description?: string): Obj => ({ type: "boolean", ...(description ? { description } : {}) });
const nullable = (s: Obj): Obj => ({ oneOf: [s, { type: "null" }] });
const arr = (items: Obj): Obj => ({ type: "array", items });
const obj = (properties: Obj, required: string[] = [], extra: Obj = {}): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}), ...extra });
const strict = (properties: Obj, required: string[]): Obj => obj(properties, required, { additionalProperties: false });
/** Big numbers (amounts, engine q, E6 prices) travel as decimal strings: a JSON number loses precision above 2^53. */
const big = (description?: string): Obj => str(description, { pattern: "^-?[0-9]+$" });
const bigOrNull = (description?: string): Obj => nullable(big(description));
/** A non-negative decimal string (an order size, an amount): no sign. */
const uint = (description?: string): Obj => str(description, { pattern: "^[0-9]+$" });
/** Basis points computed by the API (impact, spread, fees) are small bounded integers and travel as JSON numbers. */
const bps = (description?: string): Obj => nullable(int(description));

const errorStatuses = [...new Set(Object.values(ERROR_CATALOG).map((e) => e.status))].sort((a, b) => a - b);
const codesFor = (status: number): string[] => (Object.keys(ERROR_CATALOG) as ErrorCode[]).filter((c) => ERROR_CATALOG[c].status === status);

function schemas(): Obj {
  const codes = Object.keys(ERROR_CATALOG);
  const pubkey = str("Base58 public key", { pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" });
  const lot = nullable(obj({ maxQ: bigOrNull("null = no limit"), reason: nullable(str()), halted: bool() }));
  return {
    ErrorCode: { type: "string", enum: codes, description: "Stable machine-readable code. Full table in the Error codes section of this document." },
    ErrorEnvelope: obj(
      {
        error: obj(
          {
            code: ref("ErrorCode"),
            message: str("Human text. Do not parse it."),
            retryable: bool("true: the same request may succeed later. false: change the request or the state first."),
            onchain: obj({ code: int(), name: nullable(str()) }, ["code", "name"], { description: "Set when a simulation failed with a wrapper Custom(n) error." }),
            details: obj({}, [], { additionalProperties: true, description: "Extra data for some codes: notionalUsd and capUsd, maxQ and side for size_cap_exceeded, ageSecs for market_stale, `next` (the endpoint to call) for no_portfolio." }),
            logs: arr(str()),
          },
          ["code", "message", "retryable"],
        ),
      },
      ["error"],
    ),
    OracleFreshness: obj(
      {
        mode: str(),
        modeByte: int(),
        lastPushSlot: bigOrNull("Slot of the last accepted oracle push; null = never pushed"),
        ageSlots: nullable(int()),
        ageSecs: nullable(num()),
        staleBoundSecs: num(),
        staleBoundSource: { type: "string", enum: ["market", "default"] },
        stale: bool("true when ageSecs is above staleBoundSecs (or the oracle never pushed). Orders that ADD risk are refused with market_stale while this is true; reducing orders and closes are never blocked by it."),
        markEwmaE6: big(),
      },
      ["mode", "stale", "staleBoundSecs"],
    ),
    Market: obj(
      {
        market: pubkey,
        programId: pubkey,
        symbol: nullable(str()),
        name: nullable(str()),
        lotExp: int(),
        assets: int(),
        collateralMint: { ...pubkey, description: "The token the market holds as collateral" },
        collateralDecimals: nullable(int("Decimals of that token. null = a mint the API cannot value in USD: orders that add risk are refused with market_unsupported (see Units)")),
        oracleMode: str(),
        effectivePriceE6: big("Price margin and fills use, 6 decimals"),
        targetPriceE6: big(),
        markEwmaE6: big(),
        oracle: ref("OracleFreshness"),
        feeBps: big("The market's configured BASE trade fee in bps. A fill's expected fee is on the quote (expectedFeeBps); the cap a build signs is feeCapBps"),
        maxLeverage: nullable(num()),
        openInterest: obj({ longQ: big(), shortQ: big() }, ["longQ", "shortQ"]),
      },
      ["market", "programId", "collateralMint", "collateralDecimals", "effectivePriceE6", "oracle", "feeBps", "openInterest"],
    ),
    MarketDetail: {
      allOf: [
        ref("Market"),
        obj({
          risk: obj({
            initialMarginBps: big(),
            maintenanceMarginBps: big(),
            maxTradingFeeBps: big(),
            maxRequestedFeeBps: int(),
            maxAbsFundingE9PerSlot: big(),
            liquidationFeeBps: bigOrNull(),
            liquidationFeeCap: bigOrNull(),
            minNonzeroInitialMarginReq: bigOrNull(),
            minNonzeroMaintenanceMarginReq: bigOrNull(),
            execBandBps: nullable(int()),
            sideOiCapQ: bigOrNull(),
            lpFloorAtoms: bigOrNull(),
            engineMode: int(),
            sideModes: obj({ long: int(), short: int() }),
            vaultAtoms: big(),
            insuranceAtoms: big(),
          }),
        }, ["risk"]),
      ],
    },
    MarketList: obj(
      { slot: int(), observedAt: str(undefined, { format: "date-time" }), count: int(), skipped: int("Accounts left out: multi-asset or not v2.2"), markets: arr(ref("Market")) },
      ["slot", "observedAt", "count", "markets"],
    ),
    MarketOne: obj({ slot: int(), observedAt: str(undefined, { format: "date-time" }), market: ref("MarketDetail") }, ["slot", "observedAt", "market"]),
    Funding: obj(
      {
        slot: int(),
        observedAt: str(undefined, { format: "date-time" }),
        market: pubkey,
        enabled: bool(),
        active: bool(),
        direction: str("Rate above 0: longs pay shorts"),
        rateE9PerSlot: big(),
        ratePerSlot: num(),
        pctPer8h: num("What is applied now (0 unless both sides hold exposure and the oracle is price-managed)"),
        impliedPctPer8h: num("The rate before that gate"),
        premiumE9PerSlot: big(),
        skewE9PerSlot: big(),
        maxAbsE9PerSlot: big(),
        bothSidesOpen: bool(),
        priceManaged: bool(),
        slotsPer8h: int(),
      },
      ["slot", "observedAt", "market", "enabled", "active", "rateE9PerSlot", "pctPer8h"],
    ),
    Quote: obj(
      {
        market: pubkey,
        side: { type: "string", enum: ["buy", "sell"], description: "Taken from the SIGN of the quote's size query. POST /v1/orders takes side and a positive size instead." },
        sizeQ: big("Signed: above 0 buy, below 0 sell (an order's size is unsigned and the side sets the sign)"),
        notionalAtoms: big("|sizeQ| x effectivePriceE6 / 1e6, in collateral atoms"),
        effectivePriceE6: big(),
        oracle: obj({ stale: bool(), ageSecs: nullable(num()), staleBoundSecs: num() }, ["stale", "ageSecs", "staleBoundSecs"], { description: "Oracle freshness, the same rule as Market.oracle. A stale market still quotes; orders that add risk are refused." }),
        slippageBps: int(),
        limitPriceE6: big("The limit a build with this slippageBps would sign"),
        estExecPriceE6: bigOrNull("null when the matcher is unquoted or fills nothing"),
        priceImpactBps: bps("null when nothing fills"),
        totalSpreadBps: bps("null when nothing fills"),
        withinLimit: nullable(bool()),
        matcher: obj({ kind: str(), fillQ: big(), clipped: bool(), clippedByTotal: bool(), baseSpreadBps: nullable(num()), maxTotalBps: nullable(num()), adaptiveFeeBps: bps(), skewBps: bps(), feeCold: nullable(bool()) }, [], { additionalProperties: true }),
        expectedFeeBps: bps("What the fill is expected to be charged: the market's base fee plus the matcher's adaptive fee for this size, bps of notional. Growth-market utilisation fees are not included. null when nothing fills."),
        expectedFeeAtoms: bigOrNull("expectedFeeBps x notionalAtoms, rounded up, collateral atoms"),
        feeCapBps: bps("The fee cap a build signs: base fee + the matcher's worst case + a margin. It is the MOST a fill may charge, not the fee you pay, so it sits well above expectedFeeBps. null when unreadable."),
        baseFeeBps: int("The market's configured base fee (Market.feeBps, as a number here)"),
        feeChargedInPrice: bool(),
        maxSizePerSide: obj({ long: lot, short: lot }),
        exceedsMaxSize: bool("true when |sizeQ| is above maxSizePerSide for its side. A build refuses such an order with size_cap_exceeded (opens only)."),
        lotExp: int(),
      },
      ["market", "side", "sizeQ", "effectivePriceE6", "limitPriceE6", "estExecPriceE6", "oracle"],
    ),
    QuoteResponse: obj({ slot: int(), observedAt: str(undefined, { format: "date-time" }), quote: ref("Quote") }, ["slot", "observedAt", "quote"]),
    DepthRow: obj({ notionalUsd: num(), sizeQ: big(), fillQ: bigOrNull(), filledFully: bool(), execPriceE6: bigOrNull(), spreadBps: nullable(num()), impactBps: nullable(num()) }),
    DepthResponse: obj(
      {
        slot: int(),
        observedAt: str(undefined, { format: "date-time" }),
        depth: obj({
          market: pubkey,
          effectivePriceE6: big(),
          model: str("lp-curve: there is no order book on v2.2"),
          note: str(),
          asks: arr(ref("DepthRow")),
          bids: arr(ref("DepthRow")),
          maxSizePerSide: obj({ long: lot, short: lot }),
          oracle: obj({ stale: bool(), ageSecs: nullable(num()), staleBoundSecs: num() }, ["stale", "ageSecs", "staleBoundSecs"]),
          feeCapBps: bps("See Quote.feeCapBps"),
          baseFeeBps: int(),
          lotExp: int(),
        }),
      },
      ["slot", "observedAt", "depth"],
    ),
    Position: obj(
      {
        asset: int(),
        side: { type: "string", enum: ["long", "short"] },
        rawBasisQ: big(),
        sizeQ: bigOrNull("Signed, after ADL scaling"),
        entryPriceE6: bigOrNull("An estimate unless entrySource is server or cache"),
        entrySource: nullable(str()),
        entryIsEstimate: nullable(bool()),
        markPriceE6: bigOrNull(),
        unrealizedPnl: bigOrNull(),
        liqPriceE6: bigOrNull("Where the engine liquidates: the larger of the percentage maintenance requirement and the market's minimum maintenance requirement (minNonzeroMaintenanceMarginReq). Funding, fees not yet settled and the target-lag penalty are not included, so the real price can be closer."),
        notional: bigOrNull("|sizeQ| x markPriceE6 / 1e6, collateral atoms"),
        leverage: nullable(num("notional / leverageEquity of the portfolio: the SAME equity the order caps use, so a bot that stays under this number is not refused for leverage")),
        marginCushion: nullable(num()),
        severity: nullable(str()),
        adlRemainingBps: nullable(num()),
      },
      ["asset", "side"],
      { additionalProperties: true },
    ),
    Portfolio: obj(
      {
        address: pubkey,
        market: pubkey,
        programId: pubkey,
        marketStatus: { type: "string", enum: ["ok", "missing", "unsupported", "unreadable"] },
        symbol: nullable(str()),
        isLp: bool(),
        capital: big(),
        pnl: big(),
        feeCredits: big(),
        leverageEquity: big("capital + min(0, value-side PnL) + min(0, feeCredits): capital less the open position's unrealized loss and negative fee credits. Gains are not counted. The denominator of leverage and of the order leverage cap."),
        equity: big("Account value at the mark: capital + value-side PnL (a flat account: capital + settled pnl)"),
        certifiedEquity: bigOrNull("The equity recorded in the account's last health certificate, as of the engine's last crank of that account. It lags: it can differ a lot from equity (equity is at the current mark), and it is 0 or stale on an account nobody has cranked. Use equity or leverageEquity, not this, for margin decisions."),
        margin: obj({ initialMarginBps: bigOrNull(), maintenanceMarginBps: bigOrNull(), maxLeverage: nullable(num()) }),
        positions: arr(ref("Position")),
      },
      ["address", "market", "capital", "equity", "positions"],
    ),
    Account: obj({ slot: int(), observedAt: str(undefined, { format: "date-time" }), wallet: pubkey, count: int(), portfolios: arr(ref("Portfolio")) }, ["slot", "observedAt", "wallet", "count", "portfolios"]),
    HistoryItem: obj(
      {
        signature: str(),
        slot: int(),
        blockTime: nullable(int()),
        portfolios: arr(str()),
        ok: bool(),
        err: nullable(obj({ code: nullable(int()), name: nullable(str()), raw: {} })),
        memo: nullable(str()),
        confirmationStatus: nullable(str()),
      },
      ["signature", "slot", "ok"],
    ),
    History: obj(
      {
        observedAt: str(undefined, { format: "date-time" }),
        source: { type: "string", enum: ["chain-signatures"] },
        note: str(),
        slot: int(),
        wallet: pubkey,
        portfolios: arr(str()),
        truncated: bool(),
        limit: int(),
        items: arr(ref("HistoryItem")),
        nextBefore: nullable(str("Pass as ?before= for the next page; null = no more")),
      },
      ["source", "slot", "wallet", "items", "nextBefore"],
    ),
    OrderRequest: strict(
      {
        owner: { ...pubkey, description: "The wallet that will sign. Any public wallet works; only its signature makes the tx land." },
        market: pubkey,
        side: { type: "string", enum: ["buy", "sell"] },
        size: uint("Engine q, a positive decimal string, no sign (a negative size is refused). `side` sets the direction; this is NOT the signed `size` the quote takes."),
        reduceOnly: bool("Refuse unless the order shrinks the position without flipping it"),
        slippageBps: int(`Default ${DEFAULT_SLIPPAGE_BPS}, min 1, max ${MAX_SLIPPAGE_BPS}. Not with limitPriceE6. 0 is refused (a limit at the effective price cannot fill).`, { minimum: 1, maximum: MAX_SLIPPAGE_BPS }),
        limitPriceE6: uint("Explicit limit, positive; may not be more than the max slippage worse than the effective price. Not with slippageBps."),
        maxFeeBps: int("The highest fee CAP (feeCapBps, bps) you accept. A build whose cap would be higher is refused with fee_above_max. Without it the cap the market requires now is signed (it is shown as summary.feeCapBps, and is well above the expected fee), and a later utilisation-fee raise needs it (fee_raise_required).", { minimum: 0, maximum: 10000 }),
        maxNotionalUsd: { type: "number", exclusiveMinimum: 0, maximum: 1e12, description: `USD notional of THIS order, in the market's collateral (|size| x effective price). Per order, not per position: the leverage cap is the exposure limit. Can only lower the server cap (default ${DEFAULT_MAX_NOTIONAL_USD}). Fractions are honoured.` },
        maxLeverage: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: `Leverage AFTER the order: |position after| x price / leverageEquity (capital less unrealized loss, see Portfolio.leverageEquity). Can only lower the server cap (default ${DEFAULT_MAX_LEVERAGE}, or the market maximum if lower).` },
        portfolio: pubkey,
        expiresAfter: int("Unix ms. A request older than this is refused with request_expired.", { minimum: 1 }),
      },
      ["owner", "market", "side", "size"],
    ),
    CloseRequest: strict(
      {
        owner: pubkey,
        market: pubkey,
        size: uint("Part of the position to close, positive; default the whole position, never more. Measured on the ADL-effective position (Position.sizeQ), not rawBasisQ."),
        slippageBps: int(undefined, { minimum: 1, maximum: MAX_SLIPPAGE_BPS }),
        maxFeeBps: int(undefined, { minimum: 0, maximum: 10000 }),
        portfolio: pubkey,
        expiresAfter: int(undefined, { minimum: 1 }),
      },
      ["owner", "market"],
    ),
    DepositRequest: strict(
      {
        owner: pubkey,
        market: pubkey,
        amount: uint("Collateral atoms, positive (see Units for the token and its decimals)"),
        portfolio: { ...pubkey, description: "An existing trading account. Not with newPortfolio." },
        newPortfolio: { ...pubkey, description: "Public key of a fresh keypair YOU generate, when the wallet has no account yet. That keypair must co-sign the returned tx." },
        expiresAfter: int(undefined, { minimum: 1 }),
      },
      ["owner", "market", "amount"],
    ),
    WithdrawRequest: strict(
      { owner: pubkey, market: pubkey, amount: uint("Collateral atoms, positive, at most the account's capital; no open position"), portfolio: pubkey, expiresAfter: int(undefined, { minimum: 1 }) },
      ["owner", "market", "amount"],
    ),
    CancelRequest: strict({ idempotencyKey: str("The Idempotency-Key the build was sent with", { pattern: "^[A-Za-z0-9_.:-]{8,128}$" }) }, ["idempotencyKey"]),
    ReturnedTx: obj(
      {
        purpose: str("order, crank, deposit, create-and-deposit, withdraw"),
        transaction: str("Unsigned legacy transaction, base64"),
        messageHash: str("sha256 of the message bytes, hex: what the simulation ran and what signers sign"),
        signers: arr(str()),
        computeUnitLimit: int(),
        simulation: obj({ unitsConsumed: nullable(int()), logsTail: arr(str()) }, ["unitsConsumed", "logsTail"]),
      },
      ["purpose", "transaction", "messageHash", "signers", "computeUnitLimit", "simulation"],
    ),
    BuildResponse: obj(
      {
        transactions: arr(ref("ReturnedTx")),
        blockhash: str(),
        lastValidBlockHeight: int(),
        resubmitAfter: bool("true: the only tx is a maintenance crank; send it, then build again"),
        summary: obj(
          {
            market: pubkey,
            portfolio: pubkey,
            side: { type: "string", enum: ["buy", "sell"] },
            size: big("Signed engine q"),
            limitPriceE6: big(),
            effectivePriceE6: big(),
            feeCapBps: bps("The fee cap the transaction signs (the most a fill may charge). See Quote.feeCapBps."),
            expectedFeeBps: bps("The fee a fill is expected to charge (base + matcher adaptive), bps of notional"),
            expectedFeeAtoms: bigOrNull("expectedFeeBps of the order's notional, collateral atoms"),
            lotExp: int(),
            reducing: bool(),
            repairs: arr(str()),
          },
          [],
          { additionalProperties: true },
        ),
        caps: obj(
          {
            reduceOnly: bool(),
            slippageBps: nullable(int()),
            maxNotionalUsd: num(),
            maxLeverage: num(),
            notionalUsd: nullable(num()),
            leverageAfter: nullable(num()),
          },
          [],
          { description: "Orders and closes only" },
        ),
      },
      ["transactions", "blockhash", "lastValidBlockHeight", "resubmitAfter", "summary"],
    ),
    CancelResponse: obj(
      { idempotencyKey: str(), cancelled: bool(), alreadyCancelled: bool(), lastValidBlockHeight: nullable(int()), onchain: str() },
      ["idempotencyKey", "cancelled", "alreadyCancelled", "lastValidBlockHeight"],
    ),
    TxStatus: obj(
      {
        signature: str(),
        status: { type: "string", enum: ["pending", "processed", "confirmed", "finalized", "failed", "expired", "unknown"] },
        slot: nullable(int()),
        confirmations: nullable(int()),
        err: nullable(obj({ raw: {}, onchain: nullable(obj({ code: int(), name: nullable(str()) })) })),
        blockHeight: nullable(int()),
        lastValidBlockHeight: nullable(int()),
        observedAt: str(undefined, { format: "date-time" }),
      },
      ["signature", "status", "observedAt"],
    ),
    Health: obj(
      {
        status: { type: "string", enum: ["ok"] },
        version: str(),
        slot: int(),
        blockHeight: int(),
        rpcMs: int(),
        observedAt: str(undefined, { format: "date-time" }),
        kv: obj({ backend: { type: "string", enum: ["upstash", "memory"] }, degraded: bool() }),
        writesPaused: bool(),
      },
      ["status", "slot", "blockHeight"],
    ),
  };
}

const q = (name: string, schema: Obj, description: string, required = false): Obj => ({ name, in: "query", required, description, schema });
const pathParam = (name: string, description: string): Obj => ({ name, in: "path", required: true, description, schema: str() });
const json = (schema: Obj, example?: Json): Obj => ({ "application/json": { schema, ...(example !== undefined ? { example } : {}) } });

interface Op {
  summary: string;
  description?: string;
  tag: string;
  scope: "read" | "build" | "ops";
  weight: number;
  parameters?: Obj[];
  body?: string;
  idempotent?: boolean;
  ok: Obj;
  errors: number[];
}

const HEADERS_OK: Obj = {
  "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
  "X-RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
};

function operation(o: Op): Obj {
  const security: Obj[] =
    o.scope === "read"
      ? [{}, { bearerKey: [] }, { headerKey: [] }]
      : [{ bearerKey: [] }, { headerKey: [] }];
  const parameters: Obj[] = [...(o.parameters ?? [])];
  if (o.idempotent) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  const responses: Obj = { "200": { description: "OK", headers: HEADERS_OK, content: o.ok } };
  for (const s of [...new Set([...o.errors, 401, 403, 429, 500, 503])].sort((a, b) => a - b)) {
    responses[String(s)] = { $ref: `#/components/responses/Error${s}` };
  }
  return {
    summary: o.summary,
    ...(o.description ? { description: o.description } : {}),
    tags: [o.tag],
    operationId: o.summary.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toLowerCase()),
    security,
    ...(parameters.length ? { parameters } : {}),
    ...(o.body ? { requestBody: { required: true, content: json(ref(o.body)) } } : {}),
    responses,
    "x-scope": o.scope,
    "x-weight": o.weight,
  };
}

const MARKET = { $ref: "#/components/parameters/Market" };
const marketErrors = [400, 404, 503];

function paths(): Obj {
  const get = (o: Op): Obj => ({ get: operation(o) });
  const post = (o: Op): Obj => ({ post: operation(o) });
  return {
    "/api/v1/health": get({ summary: "Health", tag: "Meta", scope: "read", weight: 1, description: "RPC slot and block height, KV backend, write pause. Use it for uptime checks.", ok: json(ref("Health")), errors: [] }),
    "/api/v1/openapi.json": get({ summary: "OpenAPI document", tag: "Meta", scope: "read", weight: 1, description: "This document.", ok: json({ type: "object" }), errors: [] }),
    "/api/v1/metrics": get({
      summary: "Metrics",
      tag: "Meta",
      scope: "ops",
      weight: 1,
      description: "Request counters and latency histograms of this serverless instance, Prometheus text. Needs a key with the ops scope.",
      ok: { "text/plain": { schema: str() } },
      errors: [],
    }),
    "/api/v1/markets": get({ summary: "List markets", tag: "Markets", scope: "read", weight: 2, description: "v2.2 markets on the allowlisted wrapper program(s), one batched read.", ok: json(ref("MarketList")), errors: [503] }),
    "/api/v1/markets/{market}": get({ summary: "Get market", tag: "Markets", scope: "read", weight: 1, parameters: [MARKET], ok: json(ref("MarketOne")), errors: [...marketErrors, 422] }),
    "/api/v1/markets/{market}/funding": get({ summary: "Get funding", tag: "Markets", scope: "read", weight: 1, description: "Rate above 0 means longs pay shorts.", parameters: [MARKET], ok: json(ref("Funding")), errors: [...marketErrors, 422] }),
    "/api/v1/markets/{market}/quote": get({
      summary: "Get quote",
      tag: "Markets",
      scope: "read",
      weight: 2,
      description: "Pre-trade quote from the LP's matcher context. `size` is SIGNED engine q (above 0 buy, below 0 sell). POST /v1/orders takes an unsigned size and a `side` instead: size 1000000 with side sell is quote size -1000000.",
      parameters: [
        MARKET,
        q("size", str("Signed integer string", { pattern: "^-?[0-9]{1,39}$" }), "Signed engine q: above 0 buy, below 0 sell, never 0", true),
        q("slippageBps", int(undefined, { minimum: 1, maximum: MAX_SLIPPAGE_BPS, default: DEFAULT_SLIPPAGE_BPS }), "Slippage the returned limit is built from (min 1)"),
      ],
      ok: json(ref("QuoteResponse")),
      errors: [...marketErrors, 422],
    }),
    "/api/v1/markets/{market}/depth": get({
      summary: "Get depth",
      tag: "Markets",
      scope: "read",
      weight: 4,
      description: `The quote at notionals of ${DEPTH_LADDER_USD.join(", ")} USD per side. There is no order book on v2.2; this is the LP's curve.`,
      parameters: [MARKET],
      ok: json(ref("DepthResponse")),
      errors: [...marketErrors, 422],
    }),
    "/api/v1/accounts/{wallet}": get({
      summary: "Get account",
      tag: "Accounts",
      scope: "read",
      weight: 5,
      description: "The wallet's v2.2 trading accounts with positions and margin.",
      parameters: [pathParam("wallet", "Base58 wallet address"), q("market", str(), "Only the account on this market")],
      ok: json(ref("Account")),
      errors: [400, 503],
    }),
    "/api/v1/accounts/{wallet}/history": get({
      summary: "Get account history",
      tag: "Accounts",
      scope: "read",
      weight: 3,
      description: "Chain signatures of the wallet's trading accounts, newest first. No decoded fills yet.",
      parameters: [
        pathParam("wallet", "Base58 wallet address"),
        q("limit", int(undefined, { minimum: 1, maximum: MAX_HISTORY_LIMIT, default: DEFAULT_HISTORY_LIMIT }), "Page size"),
        q("before", str(), "Signature cursor: the nextBefore of the previous page"),
      ],
      ok: json(ref("History")),
      errors: [400, 503],
    }),
    "/api/v1/stream": get({
      summary: "Stream markets",
      tag: "Streams",
      scope: "read",
      weight: 5,
      description:
        `Server-Sent Events. A \`market\` event per market every ${SNAPSHOT_MS / 1000} s, a \`heartbeat\` every ${HEARTBEAT_MS / 1000} s, an \`error\` event when a read fails (the stream stays open). ` +
        `\`id\` is the cluster slot. The stream ends after ${MAX_STREAM_MS / 1000} s with an \`end\` event; reconnect with the Last-Event-ID header. ` +
        "Each market event is a full snapshot, so nothing needs replaying.",
      parameters: [
        q("markets", str(), "Comma-separated market addresses, 1 to 10 distinct", true),
        { name: "Last-Event-ID", in: "header", required: false, description: "Slot of the last event received; the stream never sends an older snapshot", schema: str() },
      ],
      ok: { "text/event-stream": { schema: str("Blocks of `event:`, `id:`, `data:` lines separated by a blank line") } },
      errors: [400, 404, 422],
    }),
    "/api/v1/orders": post({
      summary: "Build order",
      tag: "Trading",
      scope: "build",
      weight: 10,
      idempotent: true,
      description:
        "Builds an UNSIGNED market order (open, increase, reduce) and simulates the exact bytes it returns. The server never signs and never sends: sign `transactions[].transaction` with the wallet and send it yourself. " +
        "v2.2 has no resting orders; an order fills now against the market's LP or is refused. To modify a position, trade the difference.",
      body: "OrderRequest",
      ok: json(ref("BuildResponse")),
      errors: [400, 404, 409, 413, 422],
    }),
    "/api/v1/orders/cancel": post({
      summary: "Cancel order",
      tag: "Trading",
      scope: "build",
      weight: 1,
      description:
        "Nothing is cancelled on chain (no resting orders). This stops the API from handing the same build out again (a replay of the key gets order_cancelled) and returns lastValidBlockHeight: bytes you already hold can land until the chain passes it, never after.",
      body: "CancelRequest",
      ok: json(ref("CancelResponse")),
      errors: [400, 404, 413],
    }),
    "/api/v1/positions/close": post({
      summary: "Build close",
      tag: "Trading",
      scope: "build",
      weight: 10,
      idempotent: true,
      description: "A reduce-only order for the whole position (or `size` of it), unsigned and simulated.",
      body: "CloseRequest",
      ok: json(ref("BuildResponse")),
      errors: [400, 404, 409, 413, 422],
    }),
    "/api/v1/deposits": post({
      summary: "Build deposit",
      tag: "Funds",
      scope: "build",
      weight: 8,
      idempotent: true,
      description: "Unsigned deposit. A wallet with no trading account sends `newPortfolio` (a fresh keypair's public key) and co-signs the create-and-deposit tx with that keypair.",
      body: "DepositRequest",
      ok: json(ref("BuildResponse")),
      errors: [400, 404, 409, 413, 422],
    }),
    "/api/v1/withdrawals": post({
      summary: "Build withdrawal",
      tag: "Funds",
      scope: "build",
      weight: 8,
      idempotent: true,
      description: "Unsigned withdrawal of free capital. Refused while a position is open.",
      body: "WithdrawRequest",
      ok: json(ref("BuildResponse")),
      errors: [400, 404, 409, 413, 422],
    }),
    "/api/v1/tx/{signature}": get({
      summary: "Get transaction status",
      tag: "Trading",
      scope: "read",
      weight: 1,
      description: "`expired` means not seen and the chain is past lastValidBlockHeight: the tx can never land, rebuilding is safe. Without lastValidBlockHeight an unseen tx is `unknown`.",
      parameters: [pathParam("signature", "Base58 transaction signature"), q("lastValidBlockHeight", int(undefined, { minimum: 0 }), "From the build response")],
      ok: json(ref("TxStatus")),
      errors: [400, 503],
    }),
  };
}

function errorResponses(): Obj {
  const out: Obj = {};
  for (const s of errorStatuses) {
    out[`Error${s}`] = {
      description: `Error. Codes with this status: ${codesFor(s).join(", ")}.`,
      headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" }, ...(s === 429 || s === 503 || s === 409 ? { "Retry-After": { $ref: "#/components/headers/RetryAfter" } } : {}) },
      content: json(ref("ErrorEnvelope")),
    };
  }
  return out;
}

const tierLine = Object.entries(TIER_BUDGET).map(([t, b]) => `${t} ${b}`).join(", ");

export function buildOpenApi(): Obj {
  const catalog: Obj = {};
  for (const [code, e] of Object.entries(ERROR_CATALOG)) catalog[code] = { status: e.status, retryable: e.retryable, message: e.message };
  return {
    openapi: "3.1.0",
    info: {
      title: "Percolator bot API",
      version: API_VERSION,
      summary: "Read markets and accounts, quote, and build unsigned v2.2 transactions. Devnet only.",
      description: [
        "The API never signs and never sends. Builders return unsigned transactions that were simulated on their exact bytes; the caller signs with its own wallet and sends them.",
        "",
        "Availability: devnet v2.2 builds only, and only when the deployment has BOT_API_ENABLED=1. Otherwise every route answers 503 `disabled`.",
        "",
        `Auth: \`Authorization: Bearer pbk_<id>_<secret>\` or \`X-API-Key\`. Read endpoints also work without a key at the anonymous budget. Builders need a key with the \`build\` scope. After ${AUTH_FAIL_LIMIT} bad keys in a window an address is refused until the window ends. A key never grants wallet authority.`,
        "",
        `Rate limits: each endpoint has a weight (the \`x-weight\` of the operation); a caller spends weight from a budget of ${WINDOW_SEC} s windows. Budget per window: ${tierLine}. Builders also draw on one global ceiling of ${GLOBAL_BUILD_BUDGET} per window, of which one caller may take at most ${PRINCIPAL_BUILD_CAP}; reads and streams draw on a global read ceiling of ${GLOBAL_READ_BUDGET}. A stream is charged its weight on admission and 1 more per snapshot tick while open, with at most ${MAX_OPEN_STREAMS.anon} open streams per anonymous caller and ${MAX_OPEN_STREAMS.default} per key. 503 kv_unavailable (retryable) means the key store is down, not that the key is bad; 503 client_ip_unknown means the deployment cannot see caller addresses and anonymous access is off. Every answer carries X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset (seconds); a 429 carries Retry-After.`,
        "",
        `Idempotency: send \`Idempotency-Key\` (8 to 128 chars of A-Za-z0-9_.:-) on every build. The same key and body inside ${TTL_SEC} s returns the same bytes (header \`Idempotent-Replayed: true\`), so a retried signature is identical and the cluster dedupes it. Same key, different body: 409 idempotency_conflict. Still running: 409 idempotency_in_progress.`,
        "",
        "Getting a key: devnet keys are issued by the Percolator team (ask them); there is no self-serve sign-up yet. Reads work without a key at the anonymous budget. A key needs the `build` scope to get transactions built. Keys are stored in the deployment's key store, so a key issued for one deployment does not work on another or on a local server that uses the in-memory store (see the SDK README for local development).",
        "",
        "Units. `size`/`sizeQ` is engine q: 1,000,000 q is one LOT of the market's base asset, and a lot is 10^lotExp tokens (lotExp is on every market; most markets have 0). Prices end in E6: `effectivePriceE6` is the price of ONE LOT times 1e6. Collateral amounts are atoms of the market's collateral token: atoms = tokens x 10^decimals (Market.collateralMint, Market.collateralDecimals; the devnet Sim-USDC is 6 decimals). So the notional of an order in collateral atoms is |size| x effectivePriceE6 / 1e6, and in USD (for a USD stable) notionalAtoms / 10^decimals. Worked example: effectivePriceE6 = 980974 (0.980974 USD per lot), you want 25 USD: atoms = 25 x 10^6 = 25,000,000; size = atoms x 1e6 / effectivePriceE6 = 25,000,000 x 1,000,000 / 980,974 = 25,484,875 q. A size too small to be worth one atom is accepted by the quote with notionalAtoms 0: size what you mean in USD. Basis points (bps) are 1/100 of a percent. The API can value only collateral it knows to be a USD stable (the devnet Sim-USDC); another collateral is refused with market_unsupported for orders that add risk.",
        "",
        "Number types on the wire: engine integers (q, E6 prices, collateral atoms, the margin and fee bps stored in a market's configuration) are decimal strings; parse them as BigInt. Values the API computes (price impact, spreads, expected fee and fee cap in bps, leverage, ages) are JSON numbers. Every schema in this document says which is which, and the contract test checks real responses against it.",
        "",
        "Glossary. Trading account (called a portfolio in some field names): your collateral and positions on one market; a wallet can create one with POST /v1/deposits and `newPortfolio`. LP: the liquidity provider's account that takes the other side of every trade. Matcher: the program that prices a fill against the LP (spread, size impact, inventory skew, fee). Crank: a maintenance transaction that refreshes an account or the market; the API tells you when one is needed (`resubmitAfter`). ADL: auto-deleveraging, which scales a position down; use `sizeQ` (after ADL), not `rawBasisQ`. Oracle modes: `keeper` (a keeper pushes the price) or Pyth-pinned; `oracle.stale` says whether the price is fresh enough to open or add risk. Lot: see Units.",
        "",
        "Getting devnet collateral: the app has a faucet at /faucet (10,000 Sim-USDC per wallet per day, plus a little SOL for fees) at the app's own address. The Sim-USDC mint is in Market.collateralMint. First trade from an empty wallet: fund the wallet, POST /v1/deposits with a fresh `newPortfolio` keypair (it co-signs), sign and send, then POST /v1/orders. The SDK README has the full walkthrough.",
        "",
        "Latency: builds simulate on a Solana RPC. Against the public devnet RPC expect seconds, and an occasional rpc_unavailable (retryable) under its rate limits. A dedicated RPC is much faster; ask before you rely on timing.",
        "",
        `Freshness: every read has \`slot\` and \`observedAt\`. Request bodies are capped at ${MAX_BODY_BYTES} bytes and unknown fields are refused.`,
        "",
        "Errors: every failure is `{ error: { code, message, retryable, onchain?, details?, logs? } }`. Branch on `code` and `retryable`, not on `message`. See components.schemas.ErrorCode and the x-error-catalog extension.",
      ].join("\n"),
    },
    servers: [{ url: "/" }],
    tags: [{ name: "Meta" }, { name: "Markets" }, { name: "Accounts" }, { name: "Trading" }, { name: "Funds" }, { name: "Streams" }],
    paths: paths(),
    components: {
      securitySchemes: {
        bearerKey: { type: "http", scheme: "bearer", description: "pbk_<id>_<secret>" },
        headerKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      parameters: {
        Market: pathParam("market", "Market (slab) address, base58"),
        IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false, description: "Send on every build; see the Idempotency section of the description", schema: str(undefined, { pattern: "^[A-Za-z0-9_.:-]{8,128}$" }) },
      },
      headers: {
        XRequestId: { description: "Id of this request, for support", schema: str() },
        RateLimitLimit: { description: "Weight budget of this caller per window", schema: int() },
        RateLimitRemaining: { description: "Weight left in this window", schema: int() },
        RateLimitReset: { description: "Seconds until the window resets", schema: int() },
        RetryAfter: { description: "Seconds to wait before retrying", schema: int() },
      },
      schemas: schemas(),
      responses: errorResponses(),
    },
    "x-error-catalog": catalog,
  };
}
