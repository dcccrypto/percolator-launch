# Verifying the Percolator Program

This document explains how to verify that the on-chain Percolator program matches the source code in this repository.

## Prerequisites

- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) v2.3.13+
- [solana-verify](https://github.com/Ellipsis-Labs/solana-verify): `cargo install solana-verify`

## Quick Verify (against deployed program)

```bash
solana-verify verify-from-repo \
  --program-id <PROGRAM_ID> \
  --library-name percolator_prog \
  --mount-path program \
  https://github.com/dcccrypto/percolator-launch
```

Replace `<PROGRAM_ID>` with the deployed program address.

## Build Locally & Compare

1. **Clone the repo at the exact commit that was deployed:**
   ```bash
   git clone https://github.com/dcccrypto/percolator-launch.git
   cd percolator-launch
   git checkout <DEPLOY_COMMIT>
   ```

2. **Build with solana-verify:**
   ```bash
   solana-verify build --library-name percolator_prog -- \
     --manifest-path program/Cargo.toml
   ```

3. **Get the executable hash of your local build:**
   ```bash
   solana-verify get-executable-hash program/target/deploy/percolator_prog.so
   ```

4. **Get the executable hash of the on-chain program:**
   ```bash
   solana-verify get-program-hash <PROGRAM_ID>
   ```

5. **Compare** — if both hashes match, the on-chain program is identical to the source code.

## How It Works

`solana-verify` performs deterministic builds using Docker to ensure the build environment is reproducible. The `Cargo.lock` at the repository root is committed to pin exact dependency versions. A `target` symlink at the root points to `program/target` for compatibility with `solana-verify`'s expectations.

Key files:
- `Cargo.lock` — pinned dependencies (root-level copy for solana-verify)
- `program/Cargo.lock` — canonical lockfile
- `program/Cargo.toml` — program manifest with repository metadata
- `target` → `program/target` — symlink for build output

## CI

The verified build runs automatically via GitHub Actions on every push to `program/` or `percolator/`. See `.github/workflows/verified-build.yml`.

## Variant Builds

The default verified build produces the **full** variant (4096 accounts). For other variants (test/small/medium), additional features would need to be passed — but the production deployment uses the full variant.
