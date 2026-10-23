"use client";

import dynamic from "next/dynamic";
import { ConnectButtonPlaceholder } from "./ConnectButtonPlaceholder";

/**
 * The ConnectButton, code-split (its wallet-adapter / Privy imports stay out of the importing page's
 * first-load JS), for every place that used to declare its own `dynamic(..., { ssr: false })`.
 *
 * While its chunk loads it renders the invisible, button-sized placeholder: pages are server-rendered,
 * so a container that holds the button (the dashboard's centred connect card, the header) would
 * otherwise paint without it and then grow or shift when it arrives (measured: CLS 0.026 on
 * /portfolio, mobile). With Privy the whole tree is client-rendered and its button differs: no
 * placeholder there, as before.
 */
export const ConnectButton = dynamic(
  () => import("./ConnectButton").then((m) => m.ConnectButton),
  { ssr: false, loading: () => (process.env.NEXT_PUBLIC_PRIVY_APP_ID ? null : <ConnectButtonPlaceholder />) },
);
