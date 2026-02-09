# Percolator Program Build Guide

## Build Variants

| Variant | Command | Program ID | Notes |
|---------|---------|------------|-------|
| **Mainnet** | `cargo build-sbf --features mainnet` | `Perco1ator111111111111111111111111111111111` | Production. Compile guards active. |
| **Devnet** | `cargo build-sbf --features devnet` | Same or devnet-specific | Relaxed oracle checks (staleness/confidence skipped). |
| **Test** | `cargo build-sbf --features test` | N/A | Small slab (64 accounts), mock SPL token transfers. |

## Feature Flags

| Feature | Purpose | Safe for mainnet? |
|---------|---------|-------------------|
| `mainnet` | Enables compile-time guards against unsafe features | ✅ Required |
| `devnet` | Skips oracle staleness & confidence validation | ❌ NEVER |
| `unsafe_close` | Skips all CloseSlab validation (saves CU in tests) | ❌ NEVER |
| `test` | Small engine, mock token transfers | ❌ NEVER |
| `cu-audit` | Logs compute unit checkpoints | ⚠️ Debug only |

## Compile-Time Safety Guards

When `mainnet` is enabled, the following combinations trigger a **compile error**:

- `mainnet` + `unsafe_close` → `compile_error!("unsafe_close MUST NOT be enabled on mainnet builds!")`
- `mainnet` + `devnet` → `compile_error!("devnet feature MUST NOT be enabled on mainnet builds!")`

This makes it **impossible** to accidentally ship a devnet or test build to mainnet.

## Build Commands

```bash
# Mainnet (production)
cargo build-sbf --features mainnet

# Devnet (relaxed oracle checks)
cargo build-sbf --features devnet

# Local testing
cargo build-sbf --features test

# Verify mainnet guards work (these MUST fail):
cargo build-sbf --features mainnet,devnet        # ❌ compile error
cargo build-sbf --features mainnet,unsafe_close   # ❌ compile error
```

## AdminForceClose (Emergency Safety Valve)

The `AdminForceClose` instruction (tag 21) allows the admin to unconditionally close any position at oracle price, skipping margin checks. This is a safety valve for:

- Stuck positions that can't be liquidated normally
- Emergency market wind-down on devnet or early mainnet
- Positions with corrupted state

**Accounts:** `[admin(signer), slab(writable), clock, oracle]`

After admin renounces (`RenounceAdmin`), this instruction is permanently disabled.
