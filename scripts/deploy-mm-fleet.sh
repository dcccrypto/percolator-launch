#!/usr/bin/env bash
# PERC-372: Deploy devnet MM fleet with 2-3 keeper wallets
#
# This script:
#   1. Generates 3 keeper wallets (if not already present)
#   2. Funds them with devnet SOL (airdrop)
#   3. Starts the MM fleet with tight spreads (all within 1% of oracle)
#
# Usage:
#   ./scripts/deploy-mm-fleet.sh                # full deploy
#   ./scripts/deploy-mm-fleet.sh --dry-run      # simulation mode
#   ./scripts/deploy-mm-fleet.sh --keygen-only  # just generate wallets
#
# Prerequisites:
#   - Node.js 18+ with pnpm
#   - HELIUS_API_KEY set in environment
#   - For real deployments: funded bootstrap wallet
#
# Environment variables (override defaults):
#   HELIUS_API_KEY    — Required for devnet RPC
#   KEEPER_DIR        — Wallet directory (default: /tmp/percolator-keepers)
#   FLEET_PROFILES    — Profiles to run (default: WIDE,TIGHT_A,TIGHT_B)
#   MM_WIDE_SPREAD_BPS     — WIDE spread override (default: 40)
#   MM_TIGHT_A_SPREAD_BPS  — TIGHT_A spread override (default: 12)
#   MM_TIGHT_B_SPREAD_BPS  — TIGHT_B spread override (default: 18)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults ──
KEEPER_DIR="${KEEPER_DIR:-/tmp/percolator-keepers}"
DRY_RUN="${DRY_RUN:-false}"
KEYGEN_ONLY="${KEYGEN_ONLY:-false}"

# Tight spreads — all within 1% of oracle (100bps)
# WIDE:    0.40% = 40bps (was 60bps — tightened for PERC-372)
# TIGHT_A: 0.12% = 12bps (was 15bps — tightened for PERC-372)
# TIGHT_B: 0.18% = 18bps (was 20bps — tightened for PERC-372)
export MM_WIDE_SPREAD_BPS="${MM_WIDE_SPREAD_BPS:-40}"
export MM_TIGHT_A_SPREAD_BPS="${MM_TIGHT_A_SPREAD_BPS:-12}"
export MM_TIGHT_B_SPREAD_BPS="${MM_TIGHT_B_SPREAD_BPS:-18}"

# Parse args — fail on unknown flags to prevent accidental real deploys
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --keygen-only) KEYGEN_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--keygen-only]"
      echo ""
      echo "Options:"
      echo "  --dry-run       Simulate without sending transactions"
      echo "  --keygen-only   Only generate/check keeper wallets"
      echo ""
      echo "Environment:"
      echo "  HELIUS_API_KEY  Helius API key (required)"
      echo "  KEEPER_DIR      Wallet directory (default: /tmp/percolator-keepers)"
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $arg"
      echo "Run '$0 --help' for usage."
      exit 1
      ;;
  esac
done

# Validate required environment variables
if [ -z "${HELIUS_API_KEY:-}" ]; then
  echo "❌ HELIUS_API_KEY is not set. Required for devnet RPC."
  echo "   export HELIUS_API_KEY=your-key-here"
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     PERC-372: Devnet MM Fleet Deployment                ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║ Spreads: WIDE=${MM_WIDE_SPREAD_BPS}bps  TIGHT_A=${MM_TIGHT_A_SPREAD_BPS}bps  TIGHT_B=${MM_TIGHT_B_SPREAD_BPS}bps   ║"
echo "║ Keeper dir: $KEEPER_DIR"
echo "║ Dry run: $DRY_RUN"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Generate keeper wallets ──
echo "📋 Step 1: Generating keeper wallets..."
cd "$PROJECT_ROOT"

if [ "$DRY_RUN" = "true" ]; then
  npx tsx scripts/generate-keeper-wallets.ts --dir "$KEEPER_DIR"
else
  npx tsx scripts/generate-keeper-wallets.ts --dir "$KEEPER_DIR" --airdrop
fi

if [ "$KEYGEN_ONLY" = "true" ]; then
  echo ""
  echo "✅ Wallets generated. Exiting (--keygen-only)."
  exit 0
fi

# ── Step 2: Verify wallets exist ──
echo ""
echo "🔍 Step 2: Verifying wallets..."
# Respect FLEET_PROFILES override; default to all three
IFS=',' read -ra _PROFILES <<< "${FLEET_PROFILES:-WIDE,TIGHT_A,TIGHT_B}"
for profile_upper in "${_PROFILES[@]}"; do
  profile_lower="$(echo "$profile_upper" | tr '[:upper:]' '[:lower:]')"
  wallet_file="$KEEPER_DIR/keeper-${profile_lower}.json"
  if [ ! -f "$wallet_file" ]; then
    echo "❌ Missing wallet: $wallet_file"
    exit 1
  fi
  echo "  ✓ $wallet_file"
done

# ── Step 3: Start MM fleet ──
echo ""
echo "🚀 Step 3: Starting MM fleet..."
echo "  Profiles: ${FLEET_PROFILES:-WIDE,TIGHT_A,TIGHT_B}"
echo "  Spreads: WIDE=${MM_WIDE_SPREAD_BPS}bps, TIGHT_A=${MM_TIGHT_A_SPREAD_BPS}bps, TIGHT_B=${MM_TIGHT_B_SPREAD_BPS}bps"
echo ""

export KEEPER_WALLETS_DIR="$KEEPER_DIR"
export DRY_RUN

exec npx tsx scripts/mm-fleet.ts
