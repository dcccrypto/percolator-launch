// @vitest-environment node
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  uploads: [] as string[],
  updates: [] as Array<{
    filters: Array<[string, string]>;
    patch: Record<string, unknown>;
  }>,
  network: "devnet" as "devnet" | "mainnet",
  uploadFails: false,
  updateFails: false,
  zeroRowUpdate: false,
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  function query(patch?: Record<string, unknown>, options?: { count?: "exact" }) {
    const filters: Array<[string, string]> = [];

    const q = {
      eq(column: string, value: string) {
        filters.push([column, value]);
        return q;
      },

      async single() {
        const matches = state.rows.filter((row) =>
          filters.every(([key, value]) => row[key] === value),
        );
        return matches.length === 1
          ? { data: matches[0], error: null }
          : { data: null, error: { code: "PGRST116" } };
      },

      then(resolve: (value: unknown) => unknown) {
        state.updates.push({
          filters: [...filters],
          patch: patch ?? {},
        });

        if (!state.updateFails && !state.zeroRowUpdate) {
          for (const row of state.rows) {
            if (filters.every(([k, v]) => row[k] === v)) {
              Object.assign(row, patch);
            }
          }
        }

        return Promise.resolve({
        count: options?.count === "exact"
          ? state.zeroRowUpdate
            ? 0
            : state.rows.filter((row) =>
                filters.every(([key, value]) => row[key] === value)
              ).length
          : null,
          error: state.updateFails
            ? { message: "simulated database failure" }
            : null,
        }).then(resolve);
      },
    };

    return q;
  }

  return {
    getServerNetwork: () => state.network,
    getServiceClient: () => ({
      from: (table: string) => {
        if (table !== "markets") throw Error("Unexpected table");
        return {
          select: () => query(),
          update: (patch: Record<string, unknown>, options?: { count?: "exact" }) => query(patch, options),
        };
      },
      storage: {
        from: (bucket: string) => {
          if (bucket !== "logos") throw Error("Unexpected bucket");
          return {
            upload: async (path: string) => {
              state.uploads.push(path);
              return {
                data: state.uploadFails ? null : { path },
                error: state.uploadFails
                  ? { message: "simulated upload failure" }
                  : null,
              };
            },
            getPublicUrl: (path: string) => ({
              data: {
                publicUrl: `https://storage.example/${path}`,
              },
            }),
          };
        },
      },
    }),
  };
});

import { POST } from "@/app/api/markets/[slab]/logo/route";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+BZkAAAAASUVORK5CYII=",
  "base64",
);

function setup() {
  const slab = new PublicKey(nacl.sign.keyPair().publicKey).toBase58();
  const wallet = nacl.sign.keyPair();
  const deployer = new PublicKey(wallet.publicKey).toBase58();

  state.rows = [
    { slab_address: slab, network: "devnet", deployer, logo_url: null },
    {
      slab_address: slab,
      network: "mainnet",
      deployer: "another-creator",
      logo_url: "https://existing.example/main.png",
    },
  ];

  return { slab, wallet, deployer };
}

function signedRequest(
  slab: string,
  wallet: nacl.SignKeyPair,
  deployer: string,
) {
  const minute = Math.floor(Date.now() / 60000);
  const message = Buffer.from(`market-logo:${slab}:${minute}`, "utf8");
  const signature = Buffer.from(
    nacl.sign.detached(message, wallet.secretKey),
  ).toString("base64");

  const form = new FormData();
  form.append("deployer", deployer);
  form.append("signature", signature);
  form.append(
    "logo",
    new File([Uint8Array.from(PNG)], "logo.png", { type: "image/png" }),
  );

  return new Request(`http://localhost/api/markets/${slab}/logo`, {
    method: "POST",
    body: form,
  });
}

describe("K-03 authenticated Storage isolation", () => {
  beforeEach(() => {
    state.network = "devnet";
    state.rows = [];
    state.uploads = [];
    state.updates = [];
    state.uploadFails = false;
    state.updateFails = false;
    state.zeroRowUpdate = false;
  });

  it("signed upload updates only the devnet market", async () => {
    const { slab, wallet, deployer } = setup();

    const res = await POST(
      signedRequest(slab, wallet, deployer) as never,
      { params: Promise.resolve({ slab }) },
    );

    const path = `market-logos/devnet/${slab}.png`;

    expect(res.status).toBe(200);
    expect(state.uploads).toEqual([path]);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filters).toContainEqual(["network", "devnet"]);

    expect(state.rows[0].logo_url).toBe(
      `https://storage.example/${path}`,
    );
    expect(state.rows[1].logo_url).toBe(
      "https://existing.example/main.png",
    );
  });


  it("signed mainnet upload changes only mainnet", async () => {
    const { slab, wallet, deployer } = setup();

    state.network = "mainnet";
    state.rows[1].deployer = deployer;

    const res = await POST(
      signedRequest(slab, wallet, deployer) as never,
      { params: Promise.resolve({ slab }) },
    );

    const path = `market-logos/mainnet/${slab}.png`;

    expect(res.status).toBe(200);
    expect(state.uploads).toEqual([path]);
    expect(state.updates).toHaveLength(1);

    expect(state.updates[0].filters).toContainEqual([
      "network",
      "mainnet",
    ]);

    expect(state.rows[0].logo_url).toBeNull();
    expect(state.rows[1].logo_url).toBe(
      `https://storage.example/${path}`,
    );
  });

  it("Storage upload failure must not update markets", async () => {
    const { slab, wallet, deployer } = setup();
    state.uploadFails = true;

    const res = await POST(
      signedRequest(slab, wallet, deployer) as never,
      { params: Promise.resolve({ slab }) },
    );

    expect(res.status).toBe(500);
    expect(state.uploads).toHaveLength(1);
    expect(state.updates).toHaveLength(0);
    expect(state.rows[0].logo_url).toBeNull();
    expect(state.rows[1].logo_url).toBe(
      "https://existing.example/main.png",
    );
  });

  it("Database failure must not return upload success", async () => {
    const { slab, wallet, deployer } = setup();
    state.updateFails = true;

    const res = await POST(
      signedRequest(slab, wallet, deployer) as never,
      { params: Promise.resolve({ slab }) },
    );

    expect(res.status).toBe(500);
    expect(state.uploads).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(state.rows[0].logo_url).toBeNull();
  });

  it("RED: zero-row update must not return success", async () => {
    const { slab, wallet, deployer } = setup();

    state.zeroRowUpdate = true;

    const res = await POST(
      signedRequest(slab, wallet, deployer) as never,
      { params: Promise.resolve({ slab }) }
    );

    expect(res.status).toBe(409);
    expect(state.updates).toHaveLength(1);
    expect(state.rows[0].logo_url).toBeNull();
  });
});
