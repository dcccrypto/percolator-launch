"use client";

import {
  FC,
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
} from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  parseHeader,
  parseConfig,
  parseEngine,
  parseAllAccounts,
  parseParams,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
  type Account,
} from "@percolator/core";
import { isMockSlab, getMockSlabState } from "@/lib/mock-trade-data";

export interface SlabState {
  /** The slab account address this provider is tracking */
  slabAddress: string;
  raw: Uint8Array | null;
  header: SlabHeader | null;
  config: MarketConfig | null;
  engine: EngineState | null;
  params: RiskParams | null;
  accounts: { idx: number; account: Account }[];
  loading: boolean;
  error: string | null;
  /** The on-chain program that owns this slab account */
  programId: PublicKey | null;
}

const defaultState: SlabState = {
  slabAddress: "",
  raw: null,
  header: null,
  config: null,
  engine: null,
  params: null,
  accounts: [],
  loading: true,
  error: null,
  programId: null,
};

const SlabContext = createContext<SlabState>(defaultState);

export const useSlabState = () => useContext(SlabContext);

const POLL_INTERVAL_MS = 3000;

export const SlabProvider: FC<{ children: ReactNode; slabAddress: string }> = ({ children, slabAddress }) => {
  const { connection } = useConnection();
  const [state, setState] = useState<SlabState>({ ...defaultState, slabAddress });
  const wsActive = useRef(false);
  const fetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!slabAddress) {
      setState((s) => ({ ...s, slabAddress, loading: false, error: "No slab address" }));
      return;
    }

    // Mock data mode — use synthetic data for design testing
    if (isMockSlab(slabAddress)) {
      const mock = getMockSlabState(slabAddress);
      if (mock) {
        setState({
          slabAddress,
          raw: null,
          header: mock.header,
          config: mock.config,
          engine: mock.engine,
          params: mock.params,
          accounts: mock.accounts,
          loading: false,
          error: null,
          programId: null,
        });
      }
      return;
    }

    const slabPk = new PublicKey(slabAddress);
    let cancelled = false;

    function parseSlab(data: Uint8Array, owner?: PublicKey) {
      if (cancelled) return;
      try {
        const header = parseHeader(data);
        const config = parseConfig(data);
        const engine = parseEngine(data);
        const params = parseParams(data);
        const accounts = parseAllAccounts(data);
        setState((s) => ({ slabAddress, raw: data, header, config, engine, params, accounts, loading: false, error: null, programId: owner ?? s.programId }));
      } catch (e) {
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }

    let subId: number | undefined;
    try {
      subId = connection.onAccountChange(slabPk, (info) => {
        if (cancelled) return;
        wsActive.current = true;
        parseSlab(new Uint8Array(info.data), info.owner);
      });
    } catch { /* ws not available */ }

    let timer: ReturnType<typeof setInterval> | undefined;
    async function poll() {
      if (cancelled) return;
      try {
        const info = await connection.getAccountInfo(slabPk);
        if (info) {
          parseSlab(new Uint8Array(info.data), info.owner);
        }
      } catch {
        // RPC failure — will retry on next poll
      }
    }

    // Adaptive polling: 30s when WS active, 3s when not
    function schedulePoll() {
      if (cancelled) return;
      const interval = wsActive.current ? 30_000 : POLL_INTERVAL_MS;
      timer = setTimeout(() => {
        poll().then(schedulePoll);
      }, interval);
    }

    fetchRef.current = poll;
    poll().then(schedulePoll);

    return () => {
      cancelled = true;
      wsActive.current = false;
      if (subId !== undefined) connection.removeAccountChangeListener(subId);
      if (timer) clearTimeout(timer);
    };
  }, [connection.rpcEndpoint, slabAddress]);

  // Re-poll immediately when tab becomes visible (browser sleep/wake)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") fetchRef.current();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return <SlabContext.Provider value={state}>{children}</SlabContext.Provider>;
};
