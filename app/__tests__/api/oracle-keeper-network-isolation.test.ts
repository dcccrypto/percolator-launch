import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { NextRequest } from "next/server";
import { signKeeperRequest } from "@/lib/keeper-hmac";

const state = vi.hoisted(() => ({
  rows: [] as Array<{
    slab_address: string;
    network: string;
    mainnet_ca: string | null;
    symbol: string;
  }>,
  filters: [] as Array<[string, string]>,
  patch: {} as Record<string, string>,
  dbCalls: 0,
}));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",

  getServiceClient: () => ({
    from(table: string) {
      if (table !== "markets") {
        throw new Error(`Unexpected table: ${table}`);
      }

      state.dbCalls++;

      const query = {
        update(values: Record<string, string>) {
          state.patch = values;
          return query;
        },

        eq(column: string, value: string) {
          state.filters.push([column, value]);
          return query;
        },

        select() {
          return query;
        },

        async single() {
          const matches = state.rows.filter((row) =>
            state.filters.every(
              ([column, value]) =>
                row[column as keyof typeof row] === value,
            ),
          );

          // PostgREST rolls back singular updates when row count is not one.
          if (matches.length !== 1) {
            return {
              data: null,
              error: { code: "PGRST116" },
            };
          }

          for (const row of matches) {
            if (state.patch.mainnet_ca !== undefined) {
              row.mainnet_ca = state.patch.mainnet_ca;
            }
          }

          return {
            data: matches[0],
            error: null,
          };
        },
      };

      return query;
    },
  }),
}));

const SECRET = "local-audit-fixture-secret";
const SLAB = "11111111111111111111111111111111";
const NEW_CA = "So11111111111111111111111111111111111111112";
const OLD_CA = "22222222222222222222222222222222";

function market(network: string) {
  return {
    slab_address: SLAB,
    network,
    mainnet_ca: OLD_CA,
    symbol: "TEST",
  };
}

async function sendRequest(validSignature = true) {
  const rawBody = JSON.stringify({
    slabAddress: SLAB,
    mainnetCA: NEW_CA,
  });

  const { timestamp, signature } = signKeeperRequest(
    SECRET,
    rawBody,
    {
      method: "POST",
      path: "/api/oracle-keeper/register",
    },
  );

  const { POST } = await import(
    "@/app/api/oracle-keeper/register/route"
  );

  return POST(
    new NextRequest(
      "http://localhost/api/oracle-keeper/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-keeper-timestamp": timestamp,
          "x-keeper-signature": validSignature
            ? signature
            : "invalid",
        },
        body: rawBody,
      },
    ),
  );
}

beforeEach(() => {
  vi.resetModules();

  state.rows = [];
  state.filters = [];
  state.patch = {};
  state.dbCalls = 0;

  process.env.KEEPER_REGISTER_SECRET = SECRET;
  process.env.KEEPER_INTERNAL_URL =
    "http://localhost:8081";

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({
        success: true,
        message: "mock keeper",
      }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();

  delete process.env.KEEPER_REGISTER_SECRET;
  delete process.env.KEEPER_INTERNAL_URL;
});

describe("Oracle Keeper — Network Isolation", () => {
  it("POSITIVE: updates the correct Devnet market", async () => {
    state.rows = [market("devnet")];

    const response = await sendRequest();

    expect(response.status).toBe(200);
    expect(state.rows[0].mainnet_ca).toBe(NEW_CA);
  });

  it("NEGATIVE: cannot update a Mainnet-only market", async () => {
    state.rows = [market("mainnet")];

    const response = await sendRequest();

    expect(response.status).toBe(404);
    expect(state.rows[0].mainnet_ca).toBe(OLD_CA);
    expect(state.filters).toContainEqual([
      "network",
      "devnet",
    ]);
  });

  it("NEGATIVE: duplicate slab remains network-isolated", async () => {
    state.rows = [
      market("devnet"),
      market("mainnet"),
    ];

    const response = await sendRequest();

    expect(response.status).toBe(200);
    expect(state.rows[0].mainnet_ca).toBe(NEW_CA);
    expect(state.rows[1].mainnet_ca).toBe(OLD_CA);
    expect(state.filters).toContainEqual([
      "network",
      "devnet",
    ]);
  });

  it("SECURITY: rejects invalid HMAC without DB mutation", async () => {
    state.rows = [market("devnet")];

    const response = await sendRequest(false);

    expect(response.status).toBe(401);
    expect(state.dbCalls).toBe(0);
    expect(state.rows[0].mainnet_ca).toBe(OLD_CA);
  });
});
