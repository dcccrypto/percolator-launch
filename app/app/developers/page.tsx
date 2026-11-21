import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Developers — Percolator",
  description:
    "Open-source code behind Percolator permissionless perpetuals on Solana: the program, risk engine, SDK and app.",
  openGraph: {
    title: "Developers — Percolator",
    description:
      "Open-source code behind Percolator permissionless perpetuals on Solana.",
    type: "website",
  },
};

const GH = "https://github.com/dcccrypto";

/** Public repos the product uses. Re-check before adding more. */
const REPOS = [
  {
    name: "percolator-sdk",
    desc: "TypeScript SDK — build transactions and read market state. Start here to integrate.",
  },
  {
    name: "percolator-prog",
    desc: "The on-chain Solana program (Rust).",
  },
  {
    name: "percolator",
    desc: "No-std Rust risk engine (H + A/K), checked with Kani formal verification.",
  },
  {
    name: "percolator-launch",
    desc: "This website and the trading app (Next.js).",
  },
  {
    name: "percolator-indexer",
    desc: "Market discovery, stats and trade indexing.",
  },
  {
    name: "percolator-oracle-keeper",
    desc: "Oracle keeper that pushes price feeds to devnet markets.",
  },
  {
    name: "percolator-stake",
    desc: "Insurance LP staking program (PDA admin, formally verified with Kani).",
  },
  {
    name: "percolator-nft",
    desc: "Token-2022 position NFTs — wrap and transfer an open perp position.",
  },
  {
    name: "percolator-match",
    desc: "Passive LP + vAMM matcher called via CPI (skew-aware inventory).",
  },
] as const;

const btn =
  "inline-flex items-center gap-2 rounded-lg border border-white/[0.15] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--text)] transition-all duration-200 hover:bg-white/[0.08]";

export default function DevelopersPage() {
  return (
    <div className="relative min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-10 sm:py-16">
        <header className="mb-12 max-w-2xl">
          <span className="mb-4 inline-block rounded-full border border-white/[0.10] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Open Source · Solana
          </span>
          <h1
            className="mb-6 text-4xl font-bold tracking-tight text-[var(--text)] sm:text-6xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Build with Percolator.
          </h1>
          <p className="mb-8 text-lg leading-relaxed text-[var(--text-secondary)]">
            Everything is open source under Apache 2.0. Read the guide, grab the
            SDK, or browse the code.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/guide" className={btn}>
              Read the guide
            </Link>
            <a
              href={`${GH}/percolator-sdk`}
              target="_blank"
              rel="noopener noreferrer"
              className={btn}
            >
              SDK on GitHub
            </a>
            <a
              href={GH}
              target="_blank"
              rel="noopener noreferrer"
              className={btn}
            >
              All repos
            </a>
          </div>
        </header>

        <section className="mb-14">
          <h2
            className="mb-4 text-2xl font-bold tracking-tight text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Main repos
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {REPOS.map((r) => (
              <li key={r.name}>
                <a
                  href={`${GH}/${r.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block h-full rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 transition-colors hover:border-[rgba(124,58,237,0.35)]"
                >
                  <span className="font-mono text-sm font-semibold text-[var(--text)]">
                    {r.name}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-[var(--text-secondary)]">
                    {r.desc}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-14">
          <h2
            className="mb-4 text-2xl font-bold tracking-tight text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Contribute
          </h2>
          <ol className="max-w-2xl list-decimal space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-secondary)]">
            <li>
              Fork a repo above and run it locally (README in each repo).
            </li>
            <li>
              Pick a{" "}
              <a
                href={`${GH}/percolator-launch/labels/good%20first%20issue`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#a78bfa] hover:underline"
              >
                good first issue
              </a>{" "}
              and comment before you start.
            </li>
            <li>Open a pull request that links the issue.</li>
          </ol>
          <p className="mt-6 text-sm text-[var(--text-muted)]">
            Questions? Ask in{" "}
            <a
              href="https://discord.gg/fJa4BDBxPN"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#a78bfa] hover:underline"
            >
              Discord
            </a>
            . Found a bug?{" "}
            <Link href="/report-bug" className="text-[#a78bfa] hover:underline">
              Report it
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
