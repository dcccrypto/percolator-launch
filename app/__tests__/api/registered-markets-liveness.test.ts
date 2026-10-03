// @vitest-environment node

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * vi.mock() factories are hoisted by Vitest, so every value referenced by
 * those factories must also be created through vi.hoisted().
 */
const h = vi.hoisted(() => ({
  DEAD:
    "AcaTmUFncaVEBCvUoR57yWUseJgonUvanWHGYxmXok18",

  LIVE:
    "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy",

  BLOCKED:
    "7FBXdrm1vQ4ktQJjMwurq4cAHkVB1gKoZ7Hx3CAQv6P4",

  dbError: false,
  dbSlabs: new Set<string>(),
  missing: new Set<string>(),
  unresolved: new Set<string>(),
  chainCalls: [] as string[][],
}));

vi.mock(
  "@/lib/playground-registered-markets",
  () => ({
    readRegisteredMarkets: async () => {
      const entry = (slabAddress: string) => ({
        slabAddress,
        marketAddress: slabAddress,
        poolAddress:
          "11111111111111111111111111111111",
        dexType: "test",
        symbol: "TEST",
        label: "TEST/USDC",
        mainnetCA: null,
        collateral:
          "11111111111111111111111111111111",
        registeredAt: 1,
      });

      return [
        entry(h.DEAD),
        entry(h.LIVE),
        entry(h.BLOCKED),
      ];
    },
  }),
);

vi.mock("@/lib/blocklist", () => ({
  BLOCKED_SLAB_ADDRESSES: new Set([
    h.BLOCKED,
  ]),
}));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",

  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () =>
          h.dbError
            ? {
                data: null,
                error: {
                  message:
                    "synthetic DB failure",
                },
              }
            : {
                data: [...h.dbSlabs].map(
                  (slab_address) => ({
                    slab_address,
                  }),
                ),
                error: null,
              },
      }),
    }),
  }),
}));

vi.mock("@/lib/live-market-state", () => ({
  readSlabExistence:
    async (slabs: string[]) => {
      h.chainCalls.push([...slabs]);

      return {
        missing: new Set(h.missing),
        unresolved: new Set(
          h.unresolved,
        ),
      };
    },
}));

import { GET } from "@/app/api/playground/registered-markets/route";

beforeEach(() => {
  h.dbError = false;

  h.dbSlabs = new Set([
    h.DEAD,
    h.LIVE,
    h.BLOCKED,
  ]);

  h.missing = new Set();
  h.unresolved = new Set();
  h.chainCalls = [];
});

describe(
  "registered-markets on-chain liveness",
  () => {
    it(
      "POSITIVE CONTROL: drops a DB+Blob market whose slab is confirmed missing on-chain",
      async () => {
        h.missing = new Set([
          h.DEAD,
        ]);

        const response = await GET();

        const body =
          (await response.json()) as {
            markets: Array<{
              slabAddress: string;
            }>;
          };

        expect(
          body.markets.map(
            (market) =>
              market.slabAddress,
          ),
        ).toEqual([
          h.LIVE,
        ]);

        // Blocklisted markets must be removed before chain liveness reads.
        expect(h.chainCalls).toEqual([
          [
            h.DEAD,
            h.LIVE,
          ],
        ]);
      },
    );

    it(
      "NEGATIVE CONTROL: keeps an unresolved slab when the chain read fails",
      async () => {
        h.unresolved = new Set([
          h.DEAD,
        ]);

        const response = await GET();

        const body =
          (await response.json()) as {
            markets: Array<{
              slabAddress: string;
            }>;
          };

        expect(
          body.markets.map(
            (market) =>
              market.slabAddress,
          ),
        ).toEqual([
          h.DEAD,
          h.LIVE,
        ]);
      },
    );

    it(
      "NEGATIVE CONTROL: DB failure plus unresolved chain state still fails open",
      async () => {
        h.dbError = true;

        h.unresolved = new Set([
          h.DEAD,
          h.LIVE,
        ]);

        const response = await GET();

        const body =
          (await response.json()) as {
            markets: Array<{
              slabAddress: string;
            }>;
          };

        expect(
          body.markets.map(
            (market) =>
              market.slabAddress,
          ),
        ).toEqual([
          h.DEAD,
          h.LIVE,
        ]);
      },
    );

    it(
      "keeps the no-cache contract for the keeper liveness feed",
      async () => {
        const response = await GET();

        expect(
          response.headers.get(
            "cache-control",
          ),
        ).toBe(
          "no-store, max-age=0, must-revalidate",
        );
      },
    );
  },
);
