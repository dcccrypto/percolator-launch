'use client';

/**
 * v2.2 Earn exit: quote (simulate first), show the minimum, then send. Only mounted under NEXT_PUBLIC_DEVNET_V22
 * (components/earn/EarnExitQuote). The orchestration is lib/v22/earn-exit-run.ts; this hook wires the app's
 * connection, wallet and send path (sendUserBundle, one group, explicit compute budget).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey, Transaction, VersionedTransaction, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { sendUserBundle } from '@/lib/tx-v1/user-bundle';
import { parseFailure, resolveUserMessage } from '@/lib/limits/user-message';
import { readEarnP3Context } from '@/lib/limits/earn-p3-read';
import { deriveVaultAuthority, deriveInsuranceLpMint } from '@percolatorct/sdk';
import { portfolioScanFilters } from '@/lib/v22/layout';
import { staleCandidatesFromAccounts, type ExitContext } from '@/lib/v22/earn-exit';
import {
  quoteExit,
  sendExit,
  withExitBudget,
  type ExitMode,
  type ExitQuote,
  type ExitRunDeps,
  type ExitRunInput,
  type SimResult,
} from '@/lib/v22/earn-exit-run';
import { V22_COPY } from '@/lib/v22/copy';
import { makeStaleReader } from '@/lib/v22/stale-scan';
import { EXIT_QUOTE_MAX_AGE_MS, StaleExitQuoteError, exitQuoteKey, quoteUsable, type BoundQuote } from '@/lib/v22/exit-quote-binding';

export interface EarnExitParams {
  market: PublicKey | null;
  programId: PublicKey | null;
  collateralMint: PublicKey | null;
  /** The vault's pot (`LpVaultRegistry.domain`). */
  sourceDomain: number;
  shares: bigint;
  mode: ExitMode;
  /** `request` mode: the par estimate for the floor. */
  estimateAtoms: bigint;
}

export type ExitPhase = 'idle' | 'quoting' | 'refreshing' | 'quoted' | 'sending' | 'sent' | 'wait' | 'error';

export interface EarnExitState {
  phase: ExitPhase;
  quote: ExitQuote | null;
  /** True when `quote` replaced one the user had already seen (117). */
  requoted: boolean;
  message: string | null;
  signature: string | null;
  /** F6: the inputs + time the quote was made for (null with no quote). */
  bound?: BoundQuote | null;
}

const IDLE: EarnExitState = { phase: 'idle', quote: null, requoted: false, message: null, signature: null, bound: null };

export const __clock = { now: () => Date.now() };

function tokenAmountOf(data: Uint8Array | Buffer | null | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/** Simulate `[budget, ...ixs]` and return the redeemer destination balance of the post-state. */
export async function simulateExitTx(connection: Connection, payer: PublicKey, dest: PublicKey, ixs: TransactionInstruction[], units: number): Promise<SimResult> {
  const tx = new Transaction();
  for (const ix of withExitBudget(ixs, units)) tx.add(ix);
  tx.feePayer = payer;
  tx.recentBlockhash = '11111111111111111111111111111111';
  const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [dest.toBase58()] },
  });
  const acc = sim.value.accounts?.[0];
  let destAfter: bigint | null = null;
  if (acc && Array.isArray(acc.data) && typeof acc.data[0] === 'string') destAfter = tokenAmountOf(Buffer.from(acc.data[0], 'base64'));
  return { err: sim.value.err ?? null, logs: sim.value.logs ?? [], destAfter };
}

export function useEarnExitV22(p: EarnExitParams) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [state, setState] = useState<EarnExitState>(IDLE);
  const runId = useRef(0);
  const newExit = useRef(true);
  const readerKey = useRef<string | null>(null);
  const staleReader = useRef<ReturnType<typeof makeStaleReader<{ key: PublicKey; legs: number }>>>(makeStaleReader({ scan: async () => [], fetchMany: async () => [], toCandidates: () => [] }));
  const currentKey = exitQuoteKey({ market: p.market?.toBase58() ?? null, programId: p.programId?.toBase58() ?? null, collateralMint: p.collateralMint?.toBase58() ?? null, sourceDomain: p.sourceDomain, shares: p.shares, mode: p.mode, redeemer: wallet.publicKey?.toBase58() ?? null });
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;

  const build = useCallback(async (): Promise<{ input: ExitRunInput; deps: ExitRunDeps } | null> => {
    const payer = wallet.publicKey;
    if (!payer || !p.market || !p.programId || !p.collateralMint || p.shares <= 0n) return null;
    const market = p.market;
    const programId = p.programId;
    const [vaultAuthority] = deriveVaultAuthority(programId, market);
    const [lpMint] = deriveInsuranceLpMint(programId, market);
    const [redeemerDest, vaultToken, redeemerLpAta, earn] = await Promise.all([
      getAssociatedTokenAddress(p.collateralMint, payer),
      getAssociatedTokenAddress(p.collateralMint, vaultAuthority, true),
      getAssociatedTokenAddress(lpMint, payer),
      readEarnP3Context(connection, programId, market),
    ]);
    const bound = earn.bound === true && earn.lpPortfolio ? earn.lpPortfolio : undefined;
    const ctx: ExitContext = {
      market: { programId, market, registryDomain: p.sourceDomain },
      redeemer: payer,
      redeemerLpAta,
      redeemerDest,
      vaultToken,
      sourceDomain: p.sourceDomain,
      shares: p.shares,
      boundLpPortfolio: bound,
    };
    // F14: one scan per exit; retries re-read only the scanned accounts.
    if (newExit.current || readerKey.current !== keyRef.current) {
      newExit.current = false;
      readerKey.current = keyRef.current;
    staleReader.current = makeStaleReader({
      scan: async () => {
        const f = portfolioScanFilters();
        const rows = await connection.getProgramAccounts(programId, {
          commitment: 'confirmed',
          filters: [
            { dataSize: f.dataSize },
            ...(f.versionMemcmp ? [{ memcmp: f.versionMemcmp }] : []),
            { memcmp: { offset: 16, bytes: market.toBase58() } },
          ],
        });
        return rows.map((r) => ({ pubkey: r.pubkey, data: new Uint8Array(r.account.data) }));
      },
      fetchMany: async (keys) => {
        const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
        return infos.flatMap((a, i) => (a ? [{ pubkey: keys[i], data: new Uint8Array(a.data) }] : []));
      },
      toCandidates: (rows) => staleCandidatesFromAccounts(rows, market),
    });
    }
    const deps: ExitRunDeps = {
      readStale: () => staleReader.current.read(),
      rescanStale: () => staleReader.current.rescan(),
      readDestBalance: async () => {
        try {
          return BigInt((await connection.getTokenAccountBalance(redeemerDest, 'confirmed')).value.amount);
        } catch {
          return 0n;
        }
      },
      simulate: (ixs, units) => simulateExitTx(connection, payer, redeemerDest, ixs, units),
      send: async (ixs, units) => {
        const r = await sendUserBundle({ connection, wallet, groups: [{ instructions: ixs, computeUnits: units }], simulate: 'all' });
        return r.signatures[r.signatures.length - 1];
      },
      parse: parseFailure,
      onRefreshing: (on) => setState((s) => (s.phase === 'quoting' || s.phase === 'refreshing' || s.phase === 'sending' ? { ...s, phase: on ? 'refreshing' : s.phase === 'refreshing' ? 'quoting' : s.phase } : s)),
    };
    return { input: { ctx, mode: p.mode, estimateAtoms: p.estimateAtoms }, deps };
  }, [wallet, connection, p.market, p.programId, p.collateralMint, p.sourceDomain, p.shares, p.mode, p.estimateAtoms]);

  const failMessage = (e: unknown): string => {
    const m = resolveUserMessage(e, { surface: 'earn-withdraw' });
    return m.body;
  };

  const getQuote = useCallback(async () => {
    const id = ++runId.current;
    const keyAtStart = keyRef.current;
    newExit.current = true; // a new exit: scan once, then re-read only those accounts
    setState({ ...IDLE, phase: 'quoting' });
    try {
      const b = await build();
      if (!b) {
        setState(IDLE);
        return;
      }
      const r = await quoteExit(b.input, b.deps);
      if (id !== runId.current) return;
      if (r.status === 'quoted') setState({ phase: 'quoted', quote: r.quote, requoted: false, message: null, signature: null, bound: { key: keyAtStart, at: __clock.now() } });
      else if (r.status === 'wait-for-sweep') setState({ ...IDLE, phase: 'wait', message: V22_COPY.earnExit.wait });
      else setState({ ...IDLE, phase: 'error', message: failMessage(r.error) });
    } catch (e) {
      if (id === runId.current) setState({ ...IDLE, phase: 'error', message: failMessage(e) });
    }
  }, [build]);

  const confirm = useCallback(async () => {
    const quote = state.quote;
    if (!quote || state.phase !== 'quoted') return;
    // F6: never sign a floor made for other inputs or an old moment.
    if (!quoteUsable(state.bound ?? null, keyRef.current, __clock.now())) {
      runId.current++;
      setState(IDLE);
      throw new StaleExitQuoteError();
    }
    const keyAtStart = keyRef.current;
    const id = ++runId.current;
    setState((s) => ({ ...s, phase: 'sending' }));
    try {
      const b = await build();
      if (!b) return;
      const r = await sendExit(b.input, quote, b.deps);
      if (id !== runId.current) return;
      if (r.status === 'sent') setState({ phase: 'sent', quote: r.quote, requoted: false, message: null, signature: r.signature });
      else if (r.status === 'requoted') setState({ phase: 'quoted', quote: r.quote, requoted: true, message: V22_COPY.earnExit.requote, signature: null, bound: { key: keyAtStart, at: __clock.now() } });
      else if (r.status === 'wait-for-sweep') setState({ ...IDLE, phase: 'wait', message: V22_COPY.earnExit.wait });
      else setState({ ...IDLE, phase: 'error', message: failMessage(r.error) });
    } catch (e) {
      if (id === runId.current) setState({ ...IDLE, phase: 'error', message: failMessage(e) });
    }
  }, [state.quote, state.phase, build]);

  const reset = useCallback(() => {
    runId.current++;
    setState(IDLE);
  }, []);

  // F6: any input change drops the quote (and anything in flight); a quote also expires on its own.
  const prevKey = useRef(currentKey);
  useEffect(() => {
    if (prevKey.current === currentKey) return;
    prevKey.current = currentKey;
    runId.current++;
    setState((s) => (s.phase === 'sent' ? s : IDLE));
  }, [currentKey]);
  const boundAt = state.bound?.at ?? null;
  useEffect(() => {
    if (boundAt === null || state.phase !== 'quoted') return;
    const left = Math.max(0, EXIT_QUOTE_MAX_AGE_MS - (__clock.now() - boundAt));
    const t = setTimeout(() => {
      runId.current++;
      setState((s) => (s.phase === 'quoted' ? IDLE : s));
    }, left + 5);
    return () => clearTimeout(t);
  }, [boundAt, state.phase]);

  // Synchronous guard for the render in which an input changed (before the effect above has run): a quote for other
  // inputs is never exposed, so the Withdraw button cannot appear for it.
  const view = state.quote && state.phase === 'quoted' && state.bound?.key !== currentKey ? IDLE : state;
  return useMemo(() => ({ state: view, getQuote, confirm, reset }), [view, getQuote, confirm, reset]);
}

export type EarnExitApi = ReturnType<typeof useEarnExitV22>;
