#!/usr/bin/env bash
# GH#1691: Check that CRANK_KEYPAIR has never been committed to this repository.
# Run this before every mainnet deployment.
#
# Usage: bash scripts/check-crank-keypair-leak.sh
# Exit 0 = clean, Exit 1 = potential leak found

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CLEAN=true
ISSUES=()

echo "=== CRANK_KEYPAIR Leak Audit ==="
echo "Repo: $REPO_ROOT"
echo ""

# 1. Check git history for any CRANK_KEYPAIR= assignments (actual values)
echo "[1/4] Scanning git history for CRANK_KEYPAIR value assignments..."
if git log --all -p -- "*.env" "*.env.*" "*.json" "*.sh" "*.yaml" "*.yml" "*.toml" 2>/dev/null \
    | grep -E '^\+.*CRANK_KEYPAIR\s*=\s*.+' | grep -v 'CRANK_KEYPAIR=\s*$' | grep -v '#' | grep -q .; then
  CLEAN=false
  ISSUES+=("CRANK_KEYPAIR value found in git history for env/config files")
  git log --all -p -- "*.env" "*.env.*" "*.json" "*.sh" "*.yaml" "*.yml" "*.toml" 2>/dev/null \
    | grep -E '^\+.*CRANK_KEYPAIR\s*=\s*.+' | grep -v 'CRANK_KEYPAIR=\s*$' | grep -v '#' || true
else
  echo "  ✅ No CRANK_KEYPAIR values in env/config file history"
fi

# 2. Check if any .env files are currently tracked by git
echo "[2/4] Checking for tracked .env files..."
TRACKED_ENVS=$(git ls-files | grep -E '\.env$|\.env\.' | grep -v '.gitignore' | grep -v 'example' | grep -v 'template' | grep -v '.env.local.example' || true)
if [ -n "$TRACKED_ENVS" ]; then
  CLEAN=false
  ISSUES+=("Non-example .env files are tracked by git")
  echo "  ❌ Tracked .env files:"
  echo "$TRACKED_ENVS"
else
  echo "  ✅ No non-example .env files tracked"
fi

# 3. Scan working tree for CRANK_KEYPAIR values (base58 or array)
echo "[3/4] Scanning working tree for CRANK_KEYPAIR values..."
# Base58 key is 44-88 chars; JSON array is [N,N,...,N] (64 entries)
LEAK=$(grep -rE 'CRANK_KEYPAIR\s*=\s*(\[|[1-9A-HJ-NP-Za-km-z]{44,})' \
  --include="*.env" --include="*.env.*" --include="*.json" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next \
  . 2>/dev/null || true)
if [ -n "$LEAK" ]; then
  CLEAN=false
  ISSUES+=("CRANK_KEYPAIR value found in working tree files")
  echo "  ❌ Found:"
  echo "$LEAK"
else
  echo "  ✅ No CRANK_KEYPAIR values in working tree"
fi

# 4. Check Railway / Vercel deployment docs for any hardcoded keys
echo "[4/4] Checking docs/scripts for hardcoded keypair values..."
DOC_LEAK=$(grep -rE 'CRANK_KEYPAIR\s*=\s*(\[|[1-9A-HJ-NP-Za-km-z]{44,})' \
  --include="*.md" --include="*.txt" --include="*.sh" \
  --exclude-dir=node_modules --exclude-dir=.git \
  . 2>/dev/null || true)
if [ -n "$DOC_LEAK" ]; then
  CLEAN=false
  ISSUES+=("CRANK_KEYPAIR value found in docs/scripts")
  echo "  ❌ Found:"
  echo "$DOC_LEAK"
else
  echo "  ✅ No CRANK_KEYPAIR values in docs/scripts"
fi

echo ""
echo "=== Summary ==="
# #3487: on v17/v18 CRANK_KEYPAIR is not an on-chain oracle authority (PushOraclePrice and
# SetOraclePriceCap no longer exist). The AUTH_MARK oracle key is PLAYGROUND_KEEPER_KEYPAIR
# (falling back to DEVNET_MINT_AUTHORITY_KEYPAIR) - see lib/playground-keeper-signer.ts.
echo "Note: on v17/v18 CRANK_KEYPAIR is not an on-chain oracle authority; the AUTH_MARK oracle key is PLAYGROUND_KEEPER_KEYPAIR (or DEVNET_MINT_AUTHORITY_KEYPAIR)."
echo ""
if $CLEAN; then
  echo "✅ CLEAN — no CRANK_KEYPAIR leaks detected"
  echo ""
  echo "Next steps:"
  echo "  1. Verify Railway env vars are set correctly (not in source)"
  echo "  2. Rotate CRANK_KEYPAIR if there is any doubt about past exposure"
  exit 0
else
  echo "❌ POTENTIAL LEAKS FOUND:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
  echo ""
  echo "REQUIRED ACTIONS:"
  echo "  1. Rotate CRANK_KEYPAIR immediately (generate new keypair, update Railway env var)"
  echo "  2. If leaked in git history: rewrite history (git filter-repo) AND revoke the key"
  echo "  3. Check Railway logs for any unauthorized use of the key"
  exit 1
fi
