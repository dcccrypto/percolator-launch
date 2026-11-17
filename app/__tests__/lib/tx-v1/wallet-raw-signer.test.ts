// @vitest-environment node
/**
 * resolveRawTxSigner: v1 only when the wallet advertises it on every surface the gate reads.
 * Wallet shapes mirror the installed packages: wallet-adapter's StandardWalletAdapter (`.wallet`,
 * `.supportedTransactionVersions`) and Privy's ConnectedStandardSolanaWallet (`.standardWallet`,
 * `.address`; Privy's embedded wallet advertises ["legacy", 0] in @privy-io/react-auth 3.41.0).
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { isUserDeclineByCode, isUserRejection, isV1WalletSigningFailure, resolveRawTxSigner } from "@/lib/tx-v1/wallet-raw-signer";

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
    // Tightened (A-2): bare wording without the -32603 code / a parse failure is not enough.
    ["Unexpected error", false],
    ["Transaction not supported", false],
    ["invalid transaction", false],
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

describe("resolveRawTxSigner: remaining branches", () => {
  const dev = "solana:devnet" as const;
  it("non-object wallet and non-Standard shapes -> null", () => {
    expect(resolveRawTxSigner("wallet", pk, dev)).toBeNull();
    expect(resolveRawTxSigner({ address: "someone-else", standardWallet: standardWallet([1]) }, pk, dev)).toBeNull();
    expect(resolveRawTxSigner({ address, standardWallet: { accounts: "x", features: {} } }, pk, dev)).toBeNull();
    expect(resolveRawTxSigner({ address, standardWallet: { accounts: [], features: null } }, pk, dev)).toBeNull();
    expect(resolveRawTxSigner({}, pk, dev)).toBeNull();
  });
  it("wallet without the raw-sign capability -> null", () => {
    const noFeature = { name: "X", accounts: [{ address }], features: {} };
    expect(resolveRawTxSigner({ address, standardWallet: noFeature }, pk, dev)).toBeNull();
    const notFn = { name: "X", accounts: [{ address }], features: { "solana:signTransaction": { signTransaction: 1 } } };
    expect(resolveRawTxSigner({ address, standardWallet: notFn }, pk, dev)).toBeNull();
    const notObj = { name: "X", accounts: [{ address }], features: { "solana:signTransaction": null } };
    expect(resolveRawTxSigner({ address, standardWallet: notObj }, pk, dev)).toBeNull();
  });
  it("account without a features list is accepted; missing name -> 'unknown'; missing versions -> empty set", () => {
    const std = {
      accounts: [{ address }],
      features: { "solana:signTransaction": { signTransaction: async () => [] } },
    };
    const s = resolveRawTxSigner({ address, standardWallet: std }, pk, dev)!;
    expect(s.name).toBe("unknown");
    expect(s.versions.size).toBe(0);
    expect(s.supportsV1).toBe(false);
  });
  it("signRaw: empty input makes no wallet call", async () => {
    const std = standardWallet([1]);
    const s = resolveRawTxSigner({ address, standardWallet: std }, pk, dev)!;
    expect(await s.signRaw([])).toEqual([]);
    expect(std.sign).not.toHaveBeenCalled();
  });
  it("signRaw: non-array answer and over-long answer are errors", async () => {
    const bad = standardWallet([1], vi.fn(async () => undefined as never));
    const s1 = resolveRawTxSigner({ address, standardWallet: bad }, pk, dev)!;
    await expect(s1.signRaw([Uint8Array.of(1)])).rejects.toThrow(/returned no signed transactions for 1/);
    const long = standardWallet([1], vi.fn(async () => [{ signedTransaction: Uint8Array.of(1) }, { signedTransaction: Uint8Array.of(2) }]));
    const s2 = resolveRawTxSigner({ address, standardWallet: long }, pk, dev)!;
    await expect(s2.signRaw([Uint8Array.of(1)])).rejects.toThrow(/returned 2 signed transactions for 1/);
  });
  it("signRaw: wallet rejection propagates unchanged, including non-Error values", async () => {
    for (const reason of ["nope", 4001, null, { code: 4001 }]) {
      const std = standardWallet([1], vi.fn(async () => { throw reason; }));
      const s = resolveRawTxSigner({ address, standardWallet: std }, pk, dev)!;
      await expect(s.signRaw([Uint8Array.of(1)])).rejects.toBe(reason);
    }
  });
  it("signRaw: signs only with the connected account, not another account in the wallet", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const std = standardWallet([1]);
    std.accounts.unshift({ address: other, features: ["solana:signTransaction"] });
    const s = resolveRawTxSigner({ address, standardWallet: std }, pk, dev)!;
    await s.signRaw([Uint8Array.of(1)]);
    expect(std.sign.mock.calls[0]![0]).toMatchObject({ account: { address } });
  });
});

describe("error classifiers: remaining branches", () => {
  it.each([
    [{ code: "4001" }],
    [{ code: "ACTION_REJECTED" }],
    [{ name: "WalletUserRejectedError" }],
    [{ name: "SolanaMobileWalletAdapterProtocolError", code: -3 }],
    [{ code: "ERROR_ASSOCIATION_CANCELLED" }],
    [{ privyErrorCode: "user_exited_set_password_flow" }],
    [{ privyErrorCode: "transaction_rejected" }],
    [{ message: "wrapper", error: { code: 4001 } }],
    [{ message: "wrapper", cause: { cause: { code: 4001 } } }],
  ])("isUserDeclineByCode(%j) = true", (err) => {
    expect(isUserDeclineByCode(err)).toBe(true);
    expect(isUserRejection(err)).toBe(true);
    expect(isV1WalletSigningFailure(err)).toBe(false);
  });
  it.each([
    ["User rejected the request."],
    [{ message: "user cancelled" }],
    [null],
    [undefined],
    [42],
    [{ code: 4002 }],
    [{ code: 1, privyErrorCode: "transaction_failure" }],
    [{ name: "SolanaMobileWalletAdapterProtocolError", code: -1 }],
    [{ name: 5, code: {}, message: 7 }],
  ])("isUserDeclineByCode(%j) = false (wording alone is not a decline by code)", (err) => {
    expect(isUserDeclineByCode(err)).toBe(false);
  });
  it("errorChain stops on cycles and at depth 5", () => {
    const a: Record<string, unknown> = { message: "a" };
    a.cause = a;
    expect(isUserDeclineByCode(a)).toBe(false);
    let deep: Record<string, unknown> = { code: 4001 };
    for (let i = 0; i < 5; i++) deep = { cause: deep };
    expect(isUserDeclineByCode(deep)).toBe(false);
  });
  it("isUserRejection by wording in a wrapped message", () => {
    expect(isUserRejection(new Error("wrap", { cause: new Error("The user rejected the request") }))).toBe(true);
    expect(isUserRejection({ message: "boom" })).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
  it("isV1WalletSigningFailure: MWA invalid payloads, nested -32603, non-error values", () => {
    expect(isV1WalletSigningFailure({ name: "SolanaMobileWalletAdapterProtocolError", code: -2 })).toBe(true);
    expect(isV1WalletSigningFailure({ name: "SolanaMobileWalletAdapterProtocolError", code: -1 })).toBe(false);
    expect(isV1WalletSigningFailure({ message: "w", error: { code: -32603 } })).toBe(true);
    expect(isV1WalletSigningFailure(null)).toBe(false);
    expect(isV1WalletSigningFailure(7)).toBe(false);
    expect(isV1WalletSigningFailure({ message: "insufficient funds" })).toBe(false);
  });
});
