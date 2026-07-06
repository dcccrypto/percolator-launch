# GH#2014: Program Upgrade Authority Governance

**Issue:** [dcccrypto/percolator-launch#2014](https://github.com/dcccrypto/percolator-launch/issues/2014)  
**Related:** GH#1823, PERC-8168, [SQUADS-SETUP.md](./SQUADS-SETUP.md)

---

## Problem

The Percolator mainnet program upgrade authority is still a **single EOA keypair** (`7JVQvrAf...`). Whoever holds that key can deploy arbitrary bytecode to the production program ID — bypassing all prior audit assumptions.

**Impact if compromised:** total loss of user funds, balance rewrites, disabled safety checks, bricked withdrawals.

---

## Required fix (operational)

1. Create a **Squads V4** multisig (recommended 2-of-3+).
2. Transfer upgrade authority to **Vault 0** PDA (not the multisig PDA itself).
3. Verify with the monitoring script (see below).

```bash
bash scripts/transfer-upgrade-authority.sh --network mainnet --new-authority <SQUADS_VAULT_0_PDA>
npx tsx scripts/check-upgrade-authority.ts --network mainnet
```

Full walkthrough: [SQUADS-SETUP.md](./SQUADS-SETUP.md)

---

## Procedural controls (post-migration)

### Timelock + mandatory review window

- All program upgrades go through Squads proposals only — never sign from the legacy deploy keypair.
- Require **48h minimum** review between proposal creation and execution on mainnet.
- Attach: diff hash, audit sign-off, CI test evidence, rollback plan.

### Allowlisted deployment pipeline

- Upgrades may only be built from tagged `percolator-prog` releases on `dcccrypto/percolator-prog`.
- Deploy artifacts must match CI-built `.so` checksum recorded in the Squads proposal.
- No manual `solana program deploy` from developer laptops.

### Emergency revoke / freeze plan

| Step | Action |
|------|--------|
| 1 | Suspend new market creation in UI (feature flag) |
| 2 | Squads proposal: set upgrade authority to `None` (immutable) if malicious upgrade detected |
| 3 | Notify users via status page + Discord |
| 4 | Forensics on deploy key / Squads signer compromise |

### Routine authority-state monitoring

```bash
# Fail CI / cron if mainnet authority is still EOA
npx tsx scripts/check-upgrade-authority.ts --network mainnet

# JSON output for dashboards
npx tsx scripts/check-upgrade-authority.ts --network mainnet --json
```

Classification logic: `app/lib/upgrade-authority.ts`  
Unit tests: `app/__tests__/lib/upgrade-authority.test.ts`

**Safe states:** `squads_multisig`, `immutable`  
**Unsafe states:** `known_eoa`, `other_eoa`

---

## Verification checklist

- [ ] `solana program show ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv` shows Squads vault (not `7JVQvrAf`)
- [ ] `npx tsx scripts/check-upgrade-authority.ts --network mainnet` exits 0
- [ ] Legacy deploy keypair removed from hot signing infrastructure
- [ ] Squads threshold ≥ 2-of-3 with hardware wallets
- [ ] `docs/threat-model.md` GH#1823 row marked resolved

---

## References

- [Issue #2014](https://github.com/dcccrypto/percolator-launch/issues/2014)
- [Squads setup](./SQUADS-SETUP.md)
- [Mainnet deploy runbook](./MAINNET-DEPLOY-RUNBOOK.md)
- [Pre-mainnet security checklist](./pre-mainnet-security-checklist.md)
