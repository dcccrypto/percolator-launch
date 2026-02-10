# Contributing with AI Agents

Percolator Launch is open source and built for AI-assisted development. This guide explains how you can use your AI agent (Claude, GPT, Cursor, etc.) to contribute improvements, fix bugs, and build features.

## How It Works

1. Fork the repo
2. Give your agent the context it needs (see prompts below)
3. Agent makes changes on a feature branch
4. Submit a PR — a human reviews and merges

**Branch protection is enforced** — nobody (including bots) can push directly to `main`. All changes go through PRs.

## Setup

```bash
# Fork and clone
gh repo fork dcccrypto/percolator-launch --clone
cd percolator-launch

# Install dependencies
pnpm install
cd app && pnpm install && cd ..

# Set up environment
cp app/.env.example app/.env.local
# Add your Helius API key, Supabase URL, etc.
```

## Architecture Overview

Give your agent this context before starting:

```
Percolator Launch is a Solana perpetual futures DEX launcher ("pump.fun for perps").

Stack:
- Frontend: Next.js 14 + TypeScript + Tailwind + shadcn (app/ directory)
- Backend: Hono server on Railway (packages/server/)
- Core: Shared library for Solana instruction encoding/parsing (packages/core/)
- Program: Solana BPF program in Rust (program/)
- Risk Engine: Rust crate (percolator/)
- Tests: TypeScript on-chain tests (tests/)

Design system: "Solana Terminal" — dark bg (#0A0A0F), Solana purple (#9945FF), green (#14F195), monospace fonts.
No emojis in UI. Terminal/HUD aesthetic.

Key concepts:
- Slab: A market's on-chain account (contains all positions, config, engine state)
- Crank: Background service that processes funding, liquidations, PnL
- Admin Oracle: Devnet-only — market creator pushes prices manually
- Coin-margined: Traders deposit the same token they're trading (not USDC)
- vAMM: Automatic market maker via matcher program
- Insurance LP: Deposit into insurance fund, earn yield from trading fees
```

## Contribution Areas

### Bug Fixes (Start Here)
Run the app locally and look for:
- Missing data (empty lists, "Unknown" labels, null values)
- Broken navigation or dead links
- TypeScript errors (`npx tsc --noEmit -p app/tsconfig.json`)
- Console errors in the browser
- Mobile responsiveness issues

### Frontend Improvements
- Better loading states and skeletons
- Responsive design fixes
- Accessibility improvements
- Performance optimization (reduce re-renders, lazy loading)
- Animation polish (GSAP)

### Backend Improvements
- Better error handling in API routes
- Trade history indexing (parsing on-chain transactions)
- Market statistics aggregation
- WebSocket reliability
- Crank service monitoring

### Core Package
- New instruction encoders/decoders
- Slab parser improvements
- Better TypeScript types

### Solana Program (Advanced)
- Gas optimization
- New instruction handlers
- Security improvements
- Requires Rust + Solana BPF toolchain

## Agent Prompts

### Prompt: Bug Hunt
```
Read the codebase at [repo path]. You are looking for bugs in the frontend.

For each page in app/app/, check:
1. Does data load correctly? Trace the data flow from hook → API → display
2. Are there null/undefined paths that show nothing?
3. Are BigInt values rendered safely (React can't render BigInt directly)?
4. Do error boundaries catch crashes?
5. Are loading and empty states shown?

Report each bug with: file, line, severity, description, proposed fix.
```

### Prompt: Feature Implementation
```
Read the codebase at [repo path]. Implement [feature description].

Rules:
- Create a feature branch: agent/[your-name]/[feature]
- Follow the existing code patterns and design system
- TypeScript must compile clean: npx tsc --noEmit -p app/tsconfig.json
- No emojis in UI text
- Use CSS variables from globals.css, not hardcoded colors
- Test your changes manually or with the test harness in tests/
- Write a clear PR description explaining what and why
```

### Prompt: Code Audit Loop
```
Read [specific file]. Audit it line by line for:
1. Security issues (exposed keys, missing auth, injection)
2. Logic errors (wrong math, off-by-one, race conditions)
3. Missing error handling (unhandled promises, no try/catch)
4. Performance issues (unnecessary re-renders, missing memoization)
5. Type safety (any casts, missing null checks)

For each finding, provide: severity, line number, description, fix.
Loop until the entire file is covered.
```

### Prompt: Test Writing
```
Read the test files in tests/ for patterns. Write a new test for [feature].

Test harness: tests/harness.ts
Pattern: See tests/t1-market-boot.ts

Tests run against devnet:
- Program IDs: Small=8n1YAoH..., Medium=9RKMpUG..., Large=58Xqjfa...
- Matcher: 4HcGCsy...
- Use @percolator/core for instruction encoding
- Clean up slabs after tests (CloseSlab instruction)
```

## PR Guidelines

1. **Branch naming**: `agent/[name]/[type]/[description]` (e.g., `agent/claude/fix/trade-history`)
2. **Small PRs** — one feature or fix per PR, not a kitchen sink
3. **Clear description** — what changed, why, how to test
4. **TypeScript clean** — `npx tsc --noEmit` must pass
5. **No breaking changes** — don't modify existing API signatures or database schemas
6. **No secrets** — never commit API keys, use environment variables

## Running Locally

```bash
# Frontend (dev server)
cd app && pnpm dev

# Backend (if needed)
cd packages/server && pnpm dev

# TypeScript check
npx tsc --noEmit -p app/tsconfig.json

# Run a test
npx tsx tests/t1-market-boot.ts
```

## Environment Variables

```
NEXT_PUBLIC_HELIUS_API_KEY=     # Helius RPC key (devnet)
NEXT_PUBLIC_WS_URL=             # Backend WebSocket URL
NEXT_PUBLIC_SUPABASE_URL=       # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=  # Supabase anon key
```

## Questions?

Open an issue or join the community discussion. We review PRs regularly.
