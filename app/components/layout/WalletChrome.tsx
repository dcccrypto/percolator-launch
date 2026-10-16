"use client";

import dynamic from "next/dynamic";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { isMockMode } from "@/lib/mock-mode";

/**
 * The wallet-only global chrome: the open-positions bar, the liquidation alert and the
 * "closed while you were away" notice. Each renders nothing until a wallet is connected,
 * but statically imported they put the SDK decoders and the whole portfolio scan into the
 * first-load JS of every page, connected or not.
 *
 * Their chunks are requested only once a wallet connects (or in mock mode, where the bar
 * shows mock positions). They appear after the portfolio scan finishes either way, and that
 * scan is far slower than one cached chunk, so the timing the trader sees does not change.
 */
const PositionsBar = dynamic(() => import("./PositionsBar").then((m) => m.PositionsBar), { ssr: false });
const LiquidationAlert = dynamic(() => import("./LiquidationAlert").then((m) => m.LiquidationAlert), { ssr: false });
const ClosedPositionNotice = dynamic(() => import("./ClosedPositionNotice").then((m) => m.ClosedPositionNotice), { ssr: false });

export function WalletChrome() {
  const { connected } = useWalletCompat();
  if (!connected && !isMockMode()) return null;
  return (
    <>
      <PositionsBar />
      <LiquidationAlert />
      <ClosedPositionNotice />
    </>
  );
}
