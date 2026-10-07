/**
 * Dev-only visual preview of the Devnet v2.2 surfaces with fixture data (no RPC, no wallet). 404 unless the dev
 * server runs with NEXT_PUBLIC_DEV_PREVIEW=1 (so it never ships as a reachable page).
 */
import { notFound } from "next/navigation";
import { V22Preview } from "./preview";

export default function Page() {
  if (process.env.NEXT_PUBLIC_DEV_PREVIEW !== "1") notFound();
  return <V22Preview />;
}
