"use client";

import dynamic from "next/dynamic";

/**
 * SignGuardLine, loaded after hydration. It renders nothing unless sign debugging is opted in and
 * a signature was refused, but statically imported from the root layout it put the sign guard's
 * whole error-copy graph (and through it the SDK) into the first-load JS of every page. It reads
 * the sign-guard store's last entry when it mounts, so an entry recorded before it loads still shows.
 */
export const SignGuardLine = dynamic(() => import("./SignGuardLine").then((m) => m.SignGuardLine), { ssr: false });
