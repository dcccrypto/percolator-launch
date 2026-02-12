"use client";

import Link from "next/link";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { CodeBlock } from "@/components/ui/CodeBlock";

const card = "rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6";
const h2Style = "text-lg font-bold text-white mb-4";
const h3Style = "text-sm font-semibold text-[var(--accent)] mb-2 uppercase tracking-wider";
const textMuted = "text-[13px] leading-relaxed text-[var(--text-secondary)]";
const badge = "inline-block rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider";

export default function AgentsPage() {
  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <div className="relative mx-auto max-w-4xl px-4 py-10 space-y-8">
        {/* Header */}
        <ScrollReveal>
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // contribute
              </div>
              <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                <span className="font-normal text-white/50">Agent </span>Contribution Guide
              </h1>
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
                Use your AI agent to improve Percolator Launch. Fork, build, submit PRs.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/dcccrypto/percolator-launch"
                target="_blank"
                rel="noopener noreferrer"
                className="border border-[var(--border)] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent)]/10"
              >
                View on GitHub
              </a>
              <a
                href="https://github.com/dcccrypto/percolator-launch/blob/main/CONTRIBUTING-AGENTS.md"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                Full Contributing Guide
              </a>
            </div>
          </div>
        </ScrollReveal>

        {/* How it works */}
        <div className={card}>
          <h2 className={h2Style}>How It Works</h2>
          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[var(--accent)]/10 text-sm font-bold text-[var(--accent)]">1</div>
              <div>
                <p className="text-sm font-medium text-white">Fork the repository</p>
                <p className={textMuted}>Clone dcccrypto/percolator-launch to your own GitHub</p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[var(--accent)]/10 text-sm font-bold text-[var(--accent)]">2</div>
              <div>
                <p className="text-sm font-medium text-white">Point your agent at the code</p>
                <p className={textMuted}>Give it the architecture context and a specific task</p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[var(--accent)]/10 text-sm font-bold text-[var(--accent)]">3</div>
              <div>
                <p className="text-sm font-medium text-white">Agent builds on a feature branch</p>
                <p className={textMuted}>TypeScript must compile clean. Follow the design system.</p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[var(--accent)]/10 text-sm font-bold text-[var(--accent)]">4</div>
              <div>
                <p className="text-sm font-medium text-white">Submit a PR</p>
                <p className={textMuted}>Main branch is protected. All changes go through review.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Architecture */}
        <div className={card}>
          <h2 className={h2Style}>Architecture Context</h2>
          <p className={`${textMuted} mb-4`}>
            Copy this into your agent&apos;s context window before starting any task:
          </p>
          <CodeBlock>{`Percolator Launch — Solana perpetual futures DEX launcher

Stack:
├── app/              Next.js 14 + TypeScript + Tailwind (frontend)
├── packages/server/  Hono backend on Railway (API + crank + oracle)
├── packages/core/    Shared Solana instruction encoding/parsing
├── program/          Solana BPF program (Rust)
├── percolator/       Risk engine crate (Rust)
└── tests/            On-chain TypeScript tests

Design: "Solana Terminal" — #0A0A0F bg, #9945FF purple, #14F195 green
        Monospace fonts, no emojis, terminal/HUD aesthetic

Key concepts:
- Slab = market account (positions, config, engine state)
- Crank = background funding/liquidation processor
- Admin Oracle = devnet manual price push
- Coin-margined = deposit same token you trade
- vAMM = automatic liquidity via matcher program`}</CodeBlock>
        </div>

        {/* What to work on */}
        <div className={card}>
          <h2 className={h2Style}>What To Work On</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-sm border border-[var(--border)] p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`${badge} bg-[var(--long)]/20 text-[var(--long)]`}>Easy</span>
                <h3 className="text-sm font-medium text-white">Bug Fixes</h3>
              </div>
              <p className={textMuted}>
                Fix console errors, null rendering, missing loading states, TypeScript issues, mobile layout
              </p>
            </div>
            <div className="rounded-sm border border-[var(--border)] p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`${badge} bg-[var(--long)]/20 text-[var(--long)]`}>Easy</span>
                <h3 className="text-sm font-medium text-white">UI Polish</h3>
              </div>
              <p className={textMuted}>
                Better skeletons, animations, accessibility, responsive design, performance
              </p>
            </div>
            <div className="rounded-sm border border-[var(--border)] p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`${badge} bg-[var(--warning)]/20 text-[var(--warning)]`}>Medium</span>
                <h3 className="text-sm font-medium text-white">Backend Features</h3>
              </div>
              <p className={textMuted}>
                Trade history indexing, market stats, WebSocket reliability, monitoring dashboards
              </p>
            </div>
            <div className="rounded-sm border border-[var(--border)] p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`${badge} bg-[var(--short)]/20 text-[var(--short)]`}>Hard</span>
                <h3 className="text-sm font-medium text-white">Solana Program</h3>
              </div>
              <p className={textMuted}>
                Gas optimization, new instructions, security hardening. Requires Rust + BPF toolchain.
              </p>
            </div>
          </div>
        </div>

        {/* Agent Prompts */}
        <div className={card}>
          <h2 className={h2Style}>Ready-Made Prompts</h2>
          <div className="space-y-6">
            <div>
              <h3 className={h3Style}>Bug Hunt</h3>
              <CodeBlock>{`Read the codebase. For each page in app/app/, check:
1. Does data load and display correctly?
2. Are there null/undefined paths that render nothing?
3. Are BigInt values rendered safely?
4. Do error boundaries catch crashes?
5. Are loading and empty states shown?

Report: file, line, severity, description, fix.`}</CodeBlock>
            </div>
            <div>
              <h3 className={h3Style}>Feature Build</h3>
              <CodeBlock>{`Implement [your feature] in percolator-launch.

Rules:
- Branch: agent/[name]/[feature]
- TypeScript clean: npx tsc --noEmit -p app/tsconfig.json
- Use CSS variables from globals.css, not hardcoded colors
- No emojis in UI. Follow Solana Terminal design.
- Write a clear PR description.`}</CodeBlock>
            </div>
            <div>
              <h3 className={h3Style}>Security Audit</h3>
              <CodeBlock>{`Audit [file] line by line for:
1. Exposed secrets or missing auth
2. Logic errors (wrong math, race conditions)
3. Missing error handling
4. Type safety issues (any casts, null checks)
5. Performance problems

Severity + line number + fix for each finding.`}</CodeBlock>
            </div>
          </div>
        </div>

        {/* PR Rules */}
        <div className={card}>
          <h2 className={h2Style}>PR Guidelines</h2>
          <ul className="space-y-2">
            {[
              ["Branch naming", "agent/[name]/[type]/[description]"],
              ["Small PRs", "One feature or fix per PR, not a kitchen sink"],
              ["Clear description", "What changed, why, how to test"],
              ["TypeScript clean", "npx tsc --noEmit must pass with 0 errors"],
              ["No breaking changes", "Don't modify existing API signatures"],
              ["No secrets", "Use environment variables, never hardcode keys"],
            ].map(([label, desc]) => (
              <li key={label} className="flex gap-3 text-sm">
                <span className="shrink-0 font-medium text-[var(--accent)]">{label}:</span>
                <span className="text-[var(--text-secondary)]">{desc}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Quick Start */}
        <div className={card}>
          <h2 className={h2Style}>Quick Start</h2>
          <CodeBlock>{`# Fork and clone
gh repo fork dcccrypto/percolator-launch --clone
cd percolator-launch

# Install
pnpm install
cd app && pnpm install && cd ..

# Environment
cp app/.env.example app/.env.local

# Run locally
cd app && pnpm dev

# TypeScript check
npx tsc --noEmit -p app/tsconfig.json

# Run tests (needs devnet SOL)
npx tsx tests/t1-market-boot.ts`}</CodeBlock>
        </div>

        {/* Back link */}
        <div className="text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] transition-colors hover:text-white"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to Percolator Launch
          </Link>
        </div>
      </div>
    </div>
  );
}
