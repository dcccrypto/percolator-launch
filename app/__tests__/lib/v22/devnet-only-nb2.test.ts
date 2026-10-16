// @vitest-environment node
/** v2.2 QA NB-2: no v2.2 transaction is built from a non-devnet connection; the wallet adapter is told the network. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Connection } from "@solana/web3.js";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { assertDevnetConnection, DEVNET_GENESIS_HASH, WrongClusterError } from "@/lib/v22/devnet-guard";
import { getFreshBlockhash } from "@/lib/tx";
import { walletAdapterNetwork } from "@/lib/wallet-adapter-network";
import { resolveUserMessage } from "@/lib/limits/user-message";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const conn = (genesis: string | Error, hashes: string[] = ["H1", "H2", "H3"]) => {
  let i = 0;
  return {
    getGenesisHash: vi.fn(async () => { if (genesis instanceof Error) throw genesis; return genesis; }),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: hashes[Math.min(i++, hashes.length - 1)], lastValidBlockHeight: 1 })),
  } as unknown as Connection & { getGenesisHash: ReturnType<typeof vi.fn>; getLatestBlockhash: ReturnType<typeof vi.fn> };
};

describe("NB-2: devnet only", () => {
  afterEach(() => __setDevnetV22ForTest(null));

  it("a mainnet connection is refused before any blockhash is fetched (flag on)", async () => {
    __setDevnetV22ForTest(true);
    const c = conn(MAINNET_GENESIS);
    await expect(getFreshBlockhash(c)).rejects.toBeInstanceOf(WrongClusterError);
    expect(c.getLatestBlockhash).not.toHaveBeenCalled();
    expect(resolveUserMessage(new WrongClusterError(), { surface: "trade" }).kind).toBe("wrong-cluster");
  });

  it("devnet: the genesis is read once per connection and every blockhash is fetched fresh (no reuse)", async () => {
    __setDevnetV22ForTest(true);
    const c = conn(DEVNET_GENESIS_HASH);
    expect(await getFreshBlockhash(c)).toBe("H1");
    expect(await getFreshBlockhash(c)).toBe("H2");
    expect(c.getGenesisHash).toHaveBeenCalledTimes(1);
    expect(c.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("an RPC failure on the genesis read does not block and is asked again; flag off never asks", async () => {
    __setDevnetV22ForTest(true);
    const c = conn(new Error("429"));
    await expect(assertDevnetConnection(c)).resolves.toBeUndefined();
    await assertDevnetConnection(c);
    expect(c.getGenesisHash).toHaveBeenCalledTimes(2);
    __setDevnetV22ForTest(false);
    const m = conn(MAINNET_GENESIS);
    await expect(assertDevnetConnection(m)).resolves.toBeUndefined();
    expect(m.getGenesisHash).not.toHaveBeenCalled();
  });

  it("the Solflare adapter is created with the deployment's network (the cause of the 'for mainnet' warning)", () => {
    expect(walletAdapterNetwork("devnet")).toBe(WalletAdapterNetwork.Devnet);
    expect(walletAdapterNetwork("mainnet")).toBe(WalletAdapterNetwork.Mainnet);
    const s = readFileSync(path.join(__dirname, "../../../components/providers/WalletAdapterProviderClient.tsx"), "utf8");
    expect(s).toContain("new SolflareWalletAdapter({ network: walletAdapterNetwork(getConfig().network) })");
    expect(s).not.toMatch(/new SolflareWalletAdapter\(\)/);
  });

  it("the tx connection is the one shared same-origin proxy connection; the proxy serves getGenesisHash", () => {
    const compat = readFileSync(path.join(__dirname, "../../../hooks/useWalletCompat.ts"), "utf8");
    expect(compat).toMatch(/const url = getConfig\(\)\.rpcUrl;/);
    const proxy = readFileSync(path.join(__dirname, "../../../app/api/rpc/route.ts"), "utf8");
    expect(proxy).toContain('"getGenesisHash",');
    expect(proxy).toMatch(/deploymentNetwork === "devnet" && requestedNetwork === "mainnet"/);
  });
});
