# Squads Multisig Setup — Percolator Program Upgrade Authority

**Purpose:** Transfer the Percolator mainnet program upgrade authority from a single keypair (`7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G`) to a Squads V4 multisig vault. This is a **mainnet go/no-go blocker** (GH#1823, GH#2014, PERC-8168).

After transfer, verify with `npx tsx scripts/check-upgrade-authority.ts --network mainnet` (see [GH-2014-upgrade-authority-governance.md](./GH-2014-upgrade-authority-governance.md)).

**Risk:** This is a one-way operation on mainnet. Test on devnet first. Once transferred, program upgrades require multisig approval — you cannot undo this without another approved multisig transaction.

---

## Overview

| Item | Value |
|------|-------|
| Mainnet program | `ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv` |
| Current authority | `7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G` |
| Authority keypair | `~/.percolator-mainnet/keys/deploy-authority.json` |
| Devnet authority | `FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x` |
| Devnet program (medium) | `g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in` |
| Squads V4 Program | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` (same on mainnet + devnet) |

---

## Step 1 — Create Squads Multisig (Browser, 10 min)

1. Go to **https://v4.squads.so**
2. Connect your wallet (use the wallet that will be a member — ideally a hardware wallet, **not** the deploy key)
3. Click **"Create Multisig"**
4. Configure:
   - **Name:** `Percolator Upgrade Authority`
   - **Members:** Add all co-signers by wallet address
     - Recommended minimum: **2-of-3** threshold
     - Add Khubair's primary wallet + 2 trusted hardware wallets
   - **Threshold:** `2` (require 2 approvals for any upgrade)
   - **Time lock:** `0` for now (can increase later via config proposal)
5. Confirm and submit the transaction
6. **Record the Multisig address** shown on the created multisig page

> 💡 The multisig address is the PDA; the **vault** is a derived PDA used as the actual authority. See Step 2.

---

## Step 2 — Get the Vault PDA (the actual new authority)

The vault PDA (index 0) is what you'll set as the new upgrade authority — NOT the multisig PDA itself.

**Option A — From Squads UI:**
1. Open your multisig at https://v4.squads.so
2. Go to **Settings → Program Manager** (or check the vault address shown under "Vault 0")
3. Copy the **Vault 0** address — this is your new upgrade authority

**Option B — Derive it programmatically:**
```bash
node -e "
const { getVaultPda } = require('@sqds/multisig');
const { PublicKey } = require('@solana/web3.js');
const [vault] = getVaultPda({ multisigPda: new PublicKey('YOUR_MULTISIG_PDA_HERE'), index: 0 });
console.log('Vault 0 (new upgrade authority):', vault.toString());
"
```

**Record this vault address** — you'll use it in Step 4.

---

## Step 3 — Devnet Test Run (Required Before Mainnet)

Run the automated test script to verify the full flow works on devnet:

```bash
cd ~/percolator-launch

# Dry-run first — shows what would happen, does NOT submit
bash scripts/transfer-upgrade-authority.sh --network devnet --dry-run

# Live devnet run (will prompt for vault PDA)
bash scripts/transfer-upgrade-authority.sh --network devnet --new-authority <DEVNET_VAULT_PDA>
```

After devnet succeeds, verify:
```bash
solana program show g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in --url devnet
# Authority should now show the vault PDA
```

---

## Step 4 — Mainnet Transfer

**Only after devnet test succeeds:**

```bash
bash scripts/transfer-upgrade-authority.sh \
  --network mainnet \
  --new-authority <SQUADS_VAULT_0_PDA>
```

The script will:
1. Verify keypair matches on-chain authority
2. Show a big warning banner
3. Require you to type `YES` to confirm
4. Submit the transaction
5. Verify on-chain that authority changed

---

## Step 5 — Future Program Upgrades via Squads

After transfer, program upgrades follow this flow:

1. Build the new program binary:
   ```bash
   cd ~/percolator-prog && anchor build
   ```
2. Go to **https://v4.squads.so** → your multisig → **Program Manager**
3. Click **"Upgrade Program"**
4. Upload the new `.so` file or paste the buffer address
5. Create a proposal — other members must approve
6. Once threshold is met, execute the upgrade

Alternatively, use the Squads CLI:
```bash
# Create upgrade proposal
squads-cli program-upgrade \
  --multisig <MULTISIG_PDA> \
  --program-id ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv \
  --buffer <BUFFER_ADDRESS> \
  --authority <VAULT_PDA>
```

---

## Rollback / Emergency

If you need to transfer authority back (e.g., from multisig to a single key for emergency):
1. Create a Squads proposal to call `set_upgrade_authority` with the new target
2. Get threshold approvals
3. Execute the proposal

There is **no shortcut** — this is the security guarantee of multisig.

---

## Checklist

- [ ] Squads multisig created at v4.squads.so
- [ ] Vault 0 PDA recorded: `___________________________`
- [ ] Multisig PDA recorded: `___________________________`
- [ ] Members added (list names/wallets): _______________
- [ ] Threshold set: ___
- [ ] Devnet test passed
- [ ] Mainnet transfer executed
- [ ] Verified on-chain: `solana program show ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv`
- [ ] Old deploy keypair secured (still needed for signing proposals as a member)
