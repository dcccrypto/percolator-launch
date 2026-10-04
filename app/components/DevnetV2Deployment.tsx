import Link from "next/link";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";

/**
 * Devnet V2 deployment addresses — read from the app's own program-id config so this can never
 * drift from what the app actually trades against. Markets are not hard-coded here: every V2
 * market is an account owned by the wrapper program, and the live, complete list is /markets.
 */
const ROWS: { label: string; id: string }[] = [
  { label: "Wrapper (Percolator program)", id: DEVNET_PROGRAM_IDS.wrapper },
  { label: "Matcher", id: DEVNET_PROGRAM_IDS.matcher },
  { label: "Stake", id: DEVNET_PROGRAM_IDS.stake },
  { label: "NFT", id: DEVNET_PROGRAM_IDS.nft },
];

const explorer = (id: string) => `https://explorer.solana.com/address/${id}?cluster=devnet`;

export function DevnetV2Deployment() {
  return (
    <section className="mt-16 mb-12" aria-labelledby="devnet-v2-deployment">
      <h2 id="devnet-v2-deployment" className="mb-2 text-xl font-semibold text-[var(--text)]">
        Devnet V2 deployment
      </h2>
      <p className="mb-5 text-sm text-[var(--text-secondary)]">
        The programs this playground runs on (Solana devnet). Every V2 market is an account owned by
        the wrapper program; the live list is on{" "}
        <Link href="/markets" className="text-[var(--accent)] hover:underline">Markets</Link>, and{" "}
        <a
          href="https://github.com/dcccrypto/percolator-launch/blob/playground/DEVNET-V2.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          DEVNET-V2.md
        </a>{" "}
        has the addresses for testing.
      </p>
      <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        {ROWS.map((r) => (
          <div key={r.label} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-[var(--text-secondary)]">{r.label}</span>
            <a
              href={explorer(r.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all font-mono text-[13px] text-[var(--text)] hover:text-[var(--accent)]"
            >
              {r.id}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
