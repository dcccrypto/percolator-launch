// @vitest-environment happy-dom
/**
 * v2.2 QA NB-2 (reopened, T-14): which way a request reached the wallet is now (a) decided PER REQUEST from the live adapter
 * (it was frozen at connect time) and (b) recorded in the sign log / `?signdebug=1` line as `signer`.
 */
import React, { useContext } from "react";
import { act, render } from "@testing-library/react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payer = { publicKey: new PublicKey("3pae8qvc8wimpETqPkxYTYMciUiRNJ5Mpu8gGvBWqLxZ") };
const mocks = vi.hoisted(() => ({
  wallet: null as unknown,
  publicKey: null as unknown,
  adapterSign: vi.fn(),
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWallet: () => ({
    publicKey: mocks.publicKey, connected: true, connecting: false, wallet: mocks.wallet,
    signTransaction: mocks.adapterSign, signAllTransactions: undefined, signMessage: undefined, disconnect: vi.fn(),
  }),
}));
vi.mock("@solana/wallet-adapter-wallets", () => ({ SolflareWalletAdapter: class { name = "Solflare"; } }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getGenesisHash: async () => (await import("@/lib/v22/devnet-guard")).DEVNET_GENESIS_HASH, isBlockhashValid: async () => ({ value: true, context: { slot: 1 } }) } }),
}));

import WalletAdapterProviderClient from "@/components/providers/WalletAdapterProviderClient";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetSignGuardForTest, noteBlockhash, signLog } from "@/lib/v22/sign-guard";

const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
function tx(): Transaction {
  const t = new Transaction().add(new TransactionInstruction({ programId: payer.publicKey, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }));
  t.recentBlockhash = BH;
  t.feePayer = payer.publicKey;
  return t;
}
let api: WalletApi | null = null;
const Probe = () => { api = useContext(WalletApiContext) as WalletApi; return null; };
const account = (chains: string[]) => ({ address: payer.publicKey.toBase58(), chains, features: ["solana:signTransaction"] });

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __resetSignGuardForTest();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.publicKey = payer.publicKey;
  mocks.adapterSign.mockReset().mockImplementation(async (t: Transaction) => t);
  api = null;
});
afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

describe("wallet bridge: the chain decision is taken per request from the live adapter", () => {
  it("a Standard wallet whose accounts are listed AFTER the bridge mounted still gets chain solana:devnet", async () => {
    const seen: string[] = [];
    const std = {
      standard: true, name: "Solflare",
      wallet: {
        accounts: [] as ReturnType<typeof account>[],
        features: { "solana:signTransaction": { signTransaction: async (...inputs: { chain: string; transaction: Uint8Array }[]) => inputs.map((i) => { seen.push(i.chain); return { signedTransaction: Buffer.from(i.transaction) as unknown as Uint8Array }; }) } },
      },
    };
    mocks.wallet = { adapter: std };
    render(<WalletAdapterProviderClient><Probe /></WalletAdapterProviderClient>);
    // accounts appear later (autoConnect before registration / a `change` event) - same adapter object, same render
    std.wallet.accounts = [account(["solana:mainnet", "solana:devnet"])];
    noteBlockhash(BH, "test", null);
    await act(async () => { await api!.signTransaction!(tx()); });
    expect(seen).toEqual(["solana:devnet"]);
    expect(mocks.adapterSign).not.toHaveBeenCalled();
    expect(signLog()[0].signer).toBe("standard Solflare + chain solana:devnet");
  });

  it("NEGATIVE CONTROL / diagnostic: a legacy adapter reaches the wallet with no chain, and the log says so", async () => {
    mocks.wallet = { adapter: { name: "Solflare", signTransaction: async () => {} } };
    render(<WalletAdapterProviderClient><Probe /></WalletAdapterProviderClient>);
    noteBlockhash(BH, "test", null);
    await act(async () => { await api!.signTransaction!(tx()); });
    expect(mocks.adapterSign).toHaveBeenCalledTimes(1);
    expect(signLog()[0].chain).toBe("none");
    expect(signLog()[0].signer).toContain("legacy adapter Solflare");
  });

  it("the second request reports how long after the first one it was made", async () => {
    mocks.wallet = { adapter: { name: "Solflare" } };
    render(<WalletAdapterProviderClient><Probe /></WalletAdapterProviderClient>);
    noteBlockhash(BH, "test", null);
    await act(async () => { await api!.signTransaction!(tx()); });
    noteBlockhash(BH, "test", null);
    await act(async () => { await api!.signTransaction!(tx()); });
    expect(signLog()[0].sinceLastMs).toBeNull();
    expect(typeof signLog()[1].sinceLastMs).toBe("number");
  });
});
