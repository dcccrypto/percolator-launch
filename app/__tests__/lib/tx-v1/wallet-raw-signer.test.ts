// @vitest-environment node
/**
 * resolveRawTxSigner: v1 only when the wallet advertises it on every surface the gate reads.
 * Wallet shapes mirror the installed packages: wallet-adapter's StandardWalletAdapter (`.wallet`,
 * `.supportedTransactionVersions`) and Privy's ConnectedStandardSolanaWallet (`.standardWallet`,
 * `.address`; Privy's embedded wallet advertises ["legacy", 0] in @privy-io/react-auth 3.41.0).
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { isUserRejection, isV1WalletSigningFailure, resolveRawTxSigner } from "@/lib/tx-v1/wallet-raw-signer";

const pk = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
const address = pk.toBase58();

function standardWallet(versions: readonly unknown[], sign = vi.fn(async (...inputs: { transaction: Uint8Array }[]) => inputs.map((i) => ({ signedTransaction: i.transaction })))) {
  return {
    name: "Std",
    accounts: [{ address, features: ["solana:signTransaction", "solana:signMessage"] }],
    features: { "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: versions, signTransaction: sign } },
    sign,
  };
}
function adapterWallet(adapterVersions: ReadonlySet<unknown> | null, featureVersions: readonly unknown[]) {
  const std = standardWallet(featureVersions);
  return { wallet: { adapter: { publicKey: pk, supportedTransactionVersions: adapterVersions, wallet: std }, readyState: "Installed" }, std };
}

describe("resolveRawTxSigner", () => {
  it("wallet-adapter wallet advertising legacy+0 (Phantom today): signer, but NOT v1", () => {
    const { wallet } = adapterWallet(new Set<unknown>(["legacy", 0]), ["legacy", 0]);
    const s = resolveRawTxSigner(wallet, pk, "solana:devnet");
    expect(s).not.toBeNull();
    expect(s!.supportsV1).toBe(false);
  });
  it("wallet-adapter wallet advertising 1 on adapter AND feature (Backpack): v1", () => {
    const { wallet } = adapterWallet(new Set<unknown>(["legacy", 0, 1]), ["legacy", 0, 1]);
    expect(resolveRawTxSigner(wallet, pk, "solana:devnet")!.supportsV1).toBe(true);
  });
  it("negative control: adapter set says 1 (from signAndSend) but signTransaction does not -> no v1", () => {
    const { wallet } = adapterWallet(new Set<unknown>(["legacy", 0, 1]), ["legacy", 0]);
    expect(resolveRawTxSigner(wallet, pk, "solana:devnet")!.supportsV1).toBe(false);
  });
  it("negative control: legacy-only adapter (versions null) -> no v1", () => {
    const { wallet } = adapterWallet(null, ["legacy", 0, 1]);
    expect(resolveRawTxSigner(wallet, pk, "solana:devnet")!.supportsV1).toBe(false);
  });
  it("non-Standard adapter (no .wallet) -> null", () => {
    expect(resolveRawTxSigner({ adapter: { publicKey: pk, supportedTransactionVersions: new Set([1]) } }, pk, "solana:devnet")).toBeNull();
  });
  it("account mismatch / no account feature -> null", () => {
    const { wallet } = adapterWallet(new Set<unknown>([1]), [1]);
    expect(resolveRawTxSigner(wallet, Keypair.generate().publicKey, "solana:devnet")).toBeNull();
    const std = standardWallet([1]);
    std.accounts[0]!.features = ["solana:signMessage"];
    expect(resolveRawTxSigner({ adapter: { publicKey: pk, supportedTransactionVersions: new Set([1]), wallet: std } }, pk, "solana:devnet")).toBeNull();
  });
  it("Privy embedded wallet (advertises legacy+0) -> no v1", () => {
    const std = standardWallet(["legacy", 0]);
    std.name = "Privy";
    const s = resolveRawTxSigner({ address, standardWallet: std }, pk, "solana:devnet");
    expect(s!.source).toBe("privy");
    expect(s!.supportsV1).toBe(false);
  });
  it("Privy-wrapped external wallet advertising 1 -> v1", () => {
    expect(resolveRawTxSigner({ address, standardWallet: standardWallet(["legacy", 0, 1]) }, pk, "solana:devnet")!.supportsV1).toBe(true);
  });
  it("null / read-only wallet -> null", () => {
    expect(resolveRawTxSigner(null, pk, "solana:devnet")).toBeNull();
    expect(resolveRawTxSigner({ adapter: {} }, null, "solana:devnet")).toBeNull();
  });
  it("signRaw: ONE feature call for N transactions, with account + chain, order preserved", async () => {
    const { wallet, std } = adapterWallet(new Set<unknown>([1]), [1]);
    const s = resolveRawTxSigner(wallet, pk, "solana:devnet")!;
    const out = await s.signRaw([Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)]);
    expect(std.sign).toHaveBeenCalledTimes(1);
    const inputs = std.sign.mock.calls[0]!;
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({ account: { address }, chain: "solana:devnet" });
    expect(out.map((u) => u[0])).toEqual([1, 2, 3]);
  });
  it("signRaw: a short wallet answer is an error, never a partial result", async () => {
    const std = standardWallet([1], vi.fn(async () => [{ signedTransaction: Uint8Array.of(1) }]));
    const s = resolveRawTxSigner({ address, standardWallet: std }, pk, "solana:devnet")!;
    await expect(s.signRaw([Uint8Array.of(1), Uint8Array.of(2)])).rejects.toThrow(/returned 1 signed transactions for 2/);
  });
});

describe("error classifiers", () => {
  it.each([
    ["Reached end of buffer unexpectedly", true],
    [{ code: -32603, message: "Unexpected error" }, true],
    [new Error("WalletSignTransactionError", { cause: new Error("Reached end of buffer unexpectedly") }), true],
    ["Unsupported transaction version", true],
    [{ code: 4001, message: "User rejected the request." }, false],
    ["User rejected the request.", false],
    ["WalletNotConnectedError", false],
    ["insufficient funds", false],
  ])("isV1WalletSigningFailure(%j) = %s", (err, want) => {
    expect(isV1WalletSigningFailure(err)).toBe(want);
  });
  it("isUserRejection", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error("Reached end of buffer unexpectedly"))).toBe(false);
  });
});
