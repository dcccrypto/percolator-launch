// @vitest-environment node
/**
 * Security review 2026-10-05 follow-ups for the v1 user-bundle helper (#3156):
 *  - L-5 / A-2: a wallet DECLINE is never a signing failure, never a fallback, never a second prompt; only
 *    genuine "cannot read v1" errors fall back, once.
 *  - A-1: the client priority price has a hard ceiling that `NEXT_PUBLIC_PRIORITY_FEE` cannot raise, and the
 *    v1 total the encoder sees is derived from the clamped price.
 *  - SDK-3 port: format rejections reach `isTxV1FormatRejection` WITH their JSON-RPC code through the app's
 *    proxy transport; transport failures and error TEXT never classify.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SendTransactionError, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  USER_BUNDLE_HEAP_BYTES,
  sendUserBundle,
  splitV1Wire,
  type PackGroup,
  type UserBundleDeps,
} from "@/lib/tx-v1/user-bundle";
import { isUserRejection, isV1WalletSigningFailure, type RawTxSigner } from "@/lib/tx-v1/wallet-raw-signer";
import { V1TransportError, sendV1ViaProxy, simulateV1ViaProxy } from "@/lib/tx-v1/rpc";
import { PRIORITY_FEE_MAX_MICRO_LAMPORTS, clampPriorityFee } from "@/lib/tx";
import {
  MAX_PRIORITY_FEE_LAMPORTS,
  V1RpcError,
  compileV1Message,
  isTxV1FormatRejection,
  sendV1 as sdkSendV1,
} from "@/lib/v21/sdk";

const walletKp = Keypair.fromSeed(new Uint8Array(32).fill(3));
const payer = walletKp.publicKey;
const PROG = new PublicKey(new Uint8Array(32).fill(9));
const BH = "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS";
const conn = new Connection("http://127.0.0.1:1");

function key(seed: number, i: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? seed : j === 1 ? i + 1 : 7)));
}
function ix(seed: number, n: number, dataLen: number): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    ...Array.from({ length: n }, (_, i) => ({ pubkey: key(seed, i), isSigner: false, isWritable: i % 2 === 0 })),
  ];
  return new TransactionInstruction({ programId: PROG, keys, data: Buffer.alloc(dataLen, seed) });
}
/** Byte-bound: one v1 tx vs 3+ legacy, so `auto` picks v1. */
const BYTE_BOUND: PackGroup<number>[] = Array.from({ length: 6 }, (_, k) => ({ instructions: [ix(10 + k, 8, 24)], computeUnits: 20_000, tag: k }));
const wallet = { publicKey: payer };

function v1Signer(signRaw?: RawTxSigner["signRaw"]): RawTxSigner {
  return {
    source: "wallet-adapter",
    name: "FakeV1",
    versions: new Set<unknown>(["legacy", 0, 1]),
    supportsV1: true,
    signRaw:
      signRaw ??
      (async (wires) =>
        wires.map((w) => {
          const { message } = splitV1Wire(w);
          const out = new Uint8Array(w);
          out.set(ed25519.sign(message, walletKp.secretKey.slice(0, 32)), message.length);
          return out;
        })),
  };
}

function deps(over: Partial<UserBundleDeps> = {}) {
  const sentV1: Uint8Array[] = [];
  const sentLegacy: Transaction[] = [];
  const signLegacy = vi.fn(async (txs: Transaction[]) => txs.map((t) => (t.partialSign(walletKp), t)));
  const d: UserBundleDeps = {
    clusterSupportsV1: async () => true,
    getBlockhash: async () => BH,
    getPriorityFee: async () => 50_000,
    simulateLegacy: async () => {},
    simulateV1: async () => ({ err: null, logs: [] }),
    signLegacy,
    sendLegacy: async (tx) => {
      sentLegacy.push(tx);
      return bs58.encode(tx.signature!);
    },
    sendV1: async (w) => {
      sentV1.push(w);
      return bs58.encode(splitV1Wire(w).signatures[0]!);
    },
    confirm: async () => {},
    rawSigner: v1Signer(),
    ...over,
  };
  return { d, sentV1, sentLegacy, signLegacy };
}

// ---------------------------------------------------------------------------
// L-5 / A-2: decline vs. genuine v1 signing failure
// ---------------------------------------------------------------------------

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

/** Real-world decline shapes (Phantom, Solflare, Backpack, Privy, wallet-adapter, Mobile Wallet Adapter). */
const DECLINES: Array<[string, unknown]> = [
  ["Phantom/EIP-1193 4001", { code: 4001, message: "User rejected the request." }],
  ["Solflare text", err("User rejected the request.")],
  ["string", "User rejected the request"],
  ["Backpack approval denied", err("Approval Denied")],
  ["Transaction cancelled", err("Transaction cancelled")],
  ["Transaction canceled by user", err("Transaction canceled by user")],
  ["Request rejected", err("Request rejected")],
  ["User declined", err("User declined to sign")],
  ["User denied signature", err("User denied transaction signature")],
  ["user closed the wallet", err("User closed the wallet")],
  ["popup closed", err("Popup window was closed")],
  ["closed the modal", err("The user closed the modal")],
  ["wallet-adapter wrapping 4001 on .error", err("", { name: "WalletSignTransactionError", error: { code: 4001, message: "User rejected the request." } })],
  ["wallet-adapter wrapping 4001 with parse-like text", err("Unexpected error", { name: "WalletSignTransactionError", error: { code: 4001, message: "Unexpected error" } })],
  ["4001 wins over -32603", err("Unexpected error", { code: -32603, cause: { code: 4001 } })],
  ["4001 wins over a parse message", { code: 4001, message: "Reached end of buffer unexpectedly" }],
  ["string code 4001", { code: "4001", message: "x" }],
  ["Privy ProviderRpcError 4001 wrapped", err("The user rejected the request", { name: "PrivyProviderRpcError", cause: err("The user rejected the request", { code: 4001, type: "provider_error" }) })],
  ["Privy client error, transaction_failure", err("Transaction was rejected by the user", { privyErrorCode: "transaction_failure", cause: err("boom") })],
  ["Privy user_exited flow", err("flow ended", { privyErrorCode: "user_exited_set_password_flow" })],
  ["MWA ERROR_NOT_SIGNED (-3)", err("not signed", { name: "SolanaMobileWalletAdapterProtocolError", code: -3 })],
  ["MWA association cancelled", err("Wallet connection cancelled by user", { name: "SolanaMobileWalletAdapterError", code: "ERROR_ASSOCIATION_CANCELLED" })],
  ["ethers ACTION_REJECTED", { code: "ACTION_REJECTED", message: "x" }],
  ["USER_REJECTED_REQUEST", { code: "USER_REJECTED_REQUEST", message: "x" }],
];

/** Genuine "this wallet cannot read a v1 transaction". */
const V1_FAILURES: Array<[string, unknown]> = [
  ["Phantom buffer underrun", err("Reached end of buffer unexpectedly")],
  ["-32603 Unexpected error", { code: -32603, message: "Unexpected error" }],
  ["wallet-adapter wrapping -32603", err("Unexpected error", { name: "WalletSignTransactionError", error: { code: -32603, message: "Unexpected error" } })],
  ["unsupported version", err("Unsupported transaction version")],
  ["version 1 not supported", err("Transaction version (1) is not supported")],
  ["versioned not supported", err("Versioned transactions are not supported")],
  ["MWA invalid payloads (-2)", err("invalid payloads", { name: "SolanaMobileWalletAdapterProtocolError", code: -2 })],
  ["cause chain", new Error("WalletSignTransactionError", { cause: new Error("failed to deserialize transaction") })],
];

/** Neither: thrown as-is (no fallback, no re-prompt). */
const OTHER: Array<[string, unknown]> = [
  ["not connected", err("WalletNotConnectedError")],
  ["insufficient funds", err("insufficient funds")],
  ["bare not supported", err("Transaction not supported")],
  ["bare invalid transaction", err("invalid transaction")],
  ["bare Unexpected error (no code)", err("Unexpected error")],
  ["network", new TypeError("Failed to fetch")],
];

describe("wallet error classifiers (L-5 / A-2)", () => {
  it.each(DECLINES)("decline %s: isUserRejection, never a signing failure", (_n, e) => {
    expect(isUserRejection(e)).toBe(true);
    expect(isV1WalletSigningFailure(e)).toBe(false);
  });
  it.each(V1_FAILURES)("genuine v1 failure %s: a signing failure, not a decline", (_n, e) => {
    expect(isUserRejection(e)).toBe(false);
    expect(isV1WalletSigningFailure(e)).toBe(true);
  });
  it.each(OTHER)("other %s: neither", (_n, e) => {
    expect(isUserRejection(e)).toBe(false);
    expect(isV1WalletSigningFailure(e)).toBe(false);
  });

  it.each(DECLINES)("sendUserBundle, decline %s: thrown as-is, wallet opened ONCE, no fallback, nothing sent", async (_n, e) => {
    const signRaw = vi.fn(async () => {
      throw e;
    });
    const r = deps({ rawSigner: v1Signer(signRaw) });
    const onFallback = vi.fn();
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.d, onFallback }).catch((x: unknown) => ({ thrown: x }));
    expect(out).toEqual({ thrown: e });
    expect(signRaw).toHaveBeenCalledTimes(1);
    expect(r.signLegacy).not.toHaveBeenCalled(); // no second wallet prompt
    expect(onFallback).not.toHaveBeenCalled();
    expect(r.sentV1).toHaveLength(0);
    expect(r.sentLegacy).toHaveLength(0);
  });

  it.each(V1_FAILURES)("sendUserBundle, genuine v1 failure %s: falls back to legacy exactly once", async (_n, e) => {
    const signRaw = vi.fn(async () => {
      throw e;
    });
    const r = deps({ rawSigner: v1Signer(signRaw) });
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.d });
    expect(out.format).toBe("legacy");
    expect(out.fellBack?.reason).toBe("wallet-cannot-sign-v1");
    expect(signRaw).toHaveBeenCalledTimes(1);
    expect(r.signLegacy).toHaveBeenCalledTimes(1);
    expect(r.sentV1).toHaveLength(0);
  });

  it("a decline of the FALLBACK legacy prompt is thrown, never retried a third time", async () => {
    const signRaw = vi.fn(async () => {
      throw err("Reached end of buffer unexpectedly");
    });
    const decline = { code: 4001, message: "User rejected the request." };
    const signLegacy = vi.fn(async () => {
      throw decline;
    });
    const r = deps({ rawSigner: v1Signer(signRaw), signLegacy });
    await expect(sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.d })).rejects.toBe(decline);
    expect(signRaw).toHaveBeenCalledTimes(1);
    expect(signLegacy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A-1: priority-fee ceiling
// ---------------------------------------------------------------------------

describe("priority fee ceiling (A-1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("clampPriorityFee: ceiling, floor and garbage", () => {
    expect(PRIORITY_FEE_MAX_MICRO_LAMPORTS).toBe(1_000_000);
    expect(clampPriorityFee(1e15)).toBe(PRIORITY_FEE_MAX_MICRO_LAMPORTS);
    expect(clampPriorityFee(Number.MAX_SAFE_INTEGER)).toBe(PRIORITY_FEE_MAX_MICRO_LAMPORTS);
    expect(clampPriorityFee(Infinity)).toBe(100_000);
    expect(clampPriorityFee(NaN)).toBe(100_000);
    expect(clampPriorityFee(-5)).toBe(100_000);
    expect(clampPriorityFee(12_345.9)).toBe(12_345);
  });

  it.each([
    ["huge env, empty fee history -> fallback is clamped", "1000000000000", [], 1_000_000],
    ["huge env, huge dynamic fees -> clamped", "1000000000000", [1e13, 1e13, 1e13, 1e13], 1_000_000],
    ["garbage env -> default fallback", "lots", [], 100_000],
    ["default env, dynamic 10x cap still applies", undefined, [5e6, 5e6, 5e6, 5e6], 1_000_000],
    ["sane env and fees pass through", "20000", [30_000, 30_000, 30_000, 30_000], 30_000],
  ])("getPriorityFee: %s", async (_n, env, fees, want) => {
    if (env !== undefined) vi.stubEnv("NEXT_PUBLIC_PRIORITY_FEE", env);
    vi.resetModules();
    const { getPriorityFee } = await import("@/lib/tx");
    const c = { getRecentPrioritizationFees: async () => fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee })) } as unknown as Connection;
    expect(await getPriorityFee(c)).toBe(want);
  });

  it.each([
    ["huge env", "1000000000000", 1_000_000],
    ["garbage env", "lots", 100_000],
    ["sane env", "20000", 20_000],
  ])("retry fallback price (priorityFeeFallback) with %s", async (_n, env, want) => {
    vi.stubEnv("NEXT_PUBLIC_PRIORITY_FEE", env);
    vi.resetModules();
    const { priorityFeeFallback } = await import("@/lib/tx");
    expect(priorityFeeFallback()).toBe(want);
  });

  it("sendUserBundle v1: an injected huge price is clamped before the encoder (total = ceiling x CU)", async () => {
    const r = deps({ getPriorityFee: async () => 1e12 });
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.d });
    expect(out.format).toBe("v1");
    const cu = Math.ceil(6 * 20_000 * 1.2);
    const expected = compileV1Message({
      payer,
      instructions: BYTE_BOUND.flatMap((g) => g.instructions),
      recentBlockhash: BH,
      config: { computeUnitLimit: cu, heapSizeBytes: USER_BUNDLE_HEAP_BYTES, priorityFeeLamports: BigInt(Math.ceil((PRIORITY_FEE_MAX_MICRO_LAMPORTS * cu) / 1e6)) },
    });
    expect(splitV1Wire(r.sentV1[0]!).message).toEqual(expected.message);
  });

  it("sendUserBundle legacy: an injected huge price is clamped in the ComputeBudget price ix", async () => {
    const r = deps({ getPriorityFee: async () => 1e12 });
    await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "off", deps: r.d });
    expect(r.sentLegacy.length).toBeGreaterThan(0);
    for (const tx of r.sentLegacy) {
      const price = tx.instructions.find((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3)!;
      expect(price.data.readBigUInt64LE(1)).toBe(BigInt(PRIORITY_FEE_MAX_MICRO_LAMPORTS));
    }
  });

  it("SDK ceiling backs it up: the encoder refuses a total above MAX_PRIORITY_FEE_LAMPORTS", () => {
    const base = { payer, instructions: [ix(1, 2, 2)], recentBlockhash: BH };
    expect(() => compileV1Message({ ...base, config: { computeUnitLimit: 1000, priorityFeeLamports: MAX_PRIORITY_FEE_LAMPORTS } })).not.toThrow();
    expect(() => compileV1Message({ ...base, config: { computeUnitLimit: 1000, priorityFeeLamports: MAX_PRIORITY_FEE_LAMPORTS + 1n } })).toThrow(/exceeds the ceiling/);
  });
});

// ---------------------------------------------------------------------------
// SDK-3 port: proxy transport keeps the JSON-RPC code; nothing else classifies
// ---------------------------------------------------------------------------

const PROXY = "http://proxy.test/api/rpc";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Echoes the request id (web3.js validates it) and answers with a JSON-RPC error object. */
const rpcErr = (code: number, message: string, status = 200) => async (_u: RequestInfo | URL, init?: RequestInit) => {
  const id = (JSON.parse(String(init?.body ?? "{}")) as { id?: unknown }).id ?? 1;
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
};
const WIRE = new Uint8Array([0x81, 1, 0, 0]);

describe("v1 transport through the /api/rpc proxy (SDK-3 port)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const proxyConn = new Connection(PROXY);

  it.each([
    [-32602, "invalid transaction: Transaction failed to sanitize accounts offsets correctly"],
    [-32602, "decoded VersionedTransaction too large: 4097 bytes (max: 4096 bytes)"],
    [-32015, "Transaction version (1) is not supported by the requesting client"],
  ])("JSON-RPC %i from the node, relayed by the proxy: V1RpcError with the code, a format rejection", async (code, message) => {
    const e = await sendV1ViaProxy(proxyConn, WIRE, rpcErr(code, message)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(V1RpcError);
    expect((e as V1RpcError).code).toBe(code);
    expect(isTxV1FormatRejection(e)).toBe(true);
    const s = await simulateV1ViaProxy(proxyConn, WIRE, rpcErr(code, message)).catch((x: unknown) => x);
    expect(isTxV1FormatRejection(s)).toBe(true);
  });

  it.each([
    ["program error (preflight)", rpcErr(-32002, 'Transaction simulation failed: {"InstructionError":[0,{"Custom":21}]}')],
    ["proxy rate limit (HTTP 429)", rpcErr(-32005, "Rate limit exceeded", 429)],
    ["proxy upstream failure", rpcErr(-32603, "Upstream RPC request failed")],
    ["proxy forbidden", rpcErr(-32600, "Forbidden", 403)],
    ["text that mentions -32602 / too large / not supported, no code", rpcErr(Number.NaN, "-32602 too large not supported bincode")],
  ])("%s: never a format rejection", async (_n, f) => {
    const e = await sendV1ViaProxy(proxyConn, WIRE, f).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(isTxV1FormatRejection(e)).toBe(false);
  });

  it.each([
    ["fetch rejects (offline)", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["abort / timeout", async () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))],
    ["network error whose cause carries a format code", async () => Promise.reject(err("socket hang up: -32602 too large not supported", { cause: { code: -32602 } }))],
    ["non-JSON gateway page", async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })],
    ["JSON without result or error", async () => json({ jsonrpc: "2.0", id: 1 })],
  ])("transport failure (%s): V1TransportError, never a format rejection", async (_n, f) => {
    const e = await sendV1ViaProxy(proxyConn, WIRE, f as typeof fetch).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(V1TransportError);
    expect(isTxV1FormatRejection(e)).toBe(false);
  });

  it("success: returns the node's signature; the request is a base64 sendTransaction with preflight on", async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => json({ jsonrpc: "2.0", id: 1, result: "SIG111" }));
    expect(await sendV1ViaProxy(proxyConn, WIRE, f)).toBe("SIG111");
    expect(f.mock.calls[0]![0]).toBe(PROXY);
    const body = JSON.parse(String(f.mock.calls[0]![1]!.body)) as { method: string; params: [string, { encoding: string; skipPreflight: boolean }] };
    expect(body.method).toBe("sendTransaction");
    expect(body.params[0]).toBe(Buffer.from(WIRE).toString("base64"));
    expect(body.params[1]).toMatchObject({ encoding: "base64", skipPreflight: false });
  });

  it("why the app does not use the SDK default: sendRawTransaction drops the JSON-RPC code (web3.js SendTransactionError)", async () => {
    const f = rpcErr(-32602, "invalid transaction: Transaction failed to sanitize accounts offsets correctly");
    const viaConnection = new Connection(PROXY, { fetch: f as unknown as typeof fetch });
    const e = await sdkSendV1(viaConnection, WIRE).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendTransactionError);
    expect((e as { code?: unknown }).code).toBeUndefined();
    expect(isTxV1FormatRejection(e)).toBe(false); // code lost: a format rejection would be a hard error
    expect(isTxV1FormatRejection(await sendV1ViaProxy(viaConnection, WIRE, f).catch((x: unknown) => x))).toBe(true);
  });

  it("sendUserBundle default deps: a proxy format rejection on the first send falls back; a network failure does not", async () => {
    const base = deps();
    const { sendV1: _s, simulateV1: _m, ...rest } = base.d;
    // simulateTransaction OK, sendTransaction -> -32602 from the node (relayed by the proxy).
    const proxy = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const { method } = JSON.parse(String(init!.body)) as { method: string };
      if (method === "simulateTransaction") return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { err: null, logs: [] } } });
      return json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid transaction: Transaction failed to sanitize" } });
    });
    vi.stubGlobal("fetch", proxy);
    const c = new Connection(PROXY, { fetch: proxy as unknown as typeof fetch });
    const out = await sendUserBundle({ connection: c, wallet, groups: BYTE_BOUND, mode: "auto", deps: rest });
    expect(out.fellBack?.reason).toBe("rpc-rejected-v1-format");
    expect(out.format).toBe("legacy");

    const sendCalls: string[] = [];
    const offline = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const { method } = JSON.parse(String(init!.body)) as { method: string };
      if (method === "simulateTransaction") return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { err: null, logs: [] } } });
      sendCalls.push(method);
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", offline);
    const r2 = deps();
    const { sendV1: _s2, simulateV1: _m2, ...rest2 } = r2.d;
    const c2 = new Connection(PROXY, { fetch: offline as unknown as typeof fetch });
    await expect(sendUserBundle({ connection: c2, wallet, groups: BYTE_BOUND, mode: "auto", deps: rest2 })).rejects.toBeInstanceOf(V1TransportError);
    expect(sendCalls).toEqual(["sendTransaction"]); // one attempt, no resend
    expect(r2.signLegacy).not.toHaveBeenCalled(); // no fallback, no second prompt
  });

  it("v1 simulation: a format rejection falls back before signing; a network failure is thrown, wallet never opened", async () => {
    const signRaw = vi.fn(async (w: readonly Uint8Array[]) => [...w]);
    const fmt = deps({ rawSigner: v1Signer(signRaw), simulateV1: async () => Promise.reject(new V1RpcError("simulateTransaction", -32602, "failed to deserialize")) });
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: fmt.d });
    expect(out.fellBack?.reason).toBe("v1-simulation-rpc-failed");
    expect(signRaw).not.toHaveBeenCalled();

    const net = deps({ rawSigner: v1Signer(signRaw), simulateV1: async () => Promise.reject(new V1TransportError("simulateTransaction", new TypeError("Failed to fetch"))) });
    await expect(sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: net.d })).rejects.toBeInstanceOf(V1TransportError);
    expect(signRaw).not.toHaveBeenCalled();
    expect(net.signLegacy).not.toHaveBeenCalled();
  });
});
