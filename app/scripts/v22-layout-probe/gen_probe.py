import os, re, sys
# Regenerates the rustc offset probe behind __tests__/fixtures/v22-rust-layout-aca02ba6.json.
# usage: PERCOLATOR_SRC=<dir holding percolator/ and percolator-prog/ at the deployed commits> python3 gen_probe.py <probe>/src/main.rs
# then: copy Cargo.toml.template to <probe>/Cargo.toml (fix the two paths), seed Cargo.lock from percolator-prog,
# `cargo run --offline > out.txt`, and rebuild the fixture from the SIZE / OFF / CONST lines.
SRC = os.environ["PERCOLATOR_SRC"]
eng = SRC + "/percolator/src/v16.rs"
wrp = SRC + "/percolator-prog/src/v16_program.rs"
specs = [
 (eng, "percolator", ["V16ConfigAccount","MarketGroupV16HeaderAccount","AssetStateV16Account","EngineAssetSlotV16Account",
   "PortfolioLegV16Account","PortfolioAccountV16Account","ProvenanceHeaderV16Account","ResolvedPayoutReceiptV16Account",
   "PortfolioSourceDomainV16Account","SourceCreditStateV16Account","BackingBucketV16Account","InsuranceCreditReservationV16Account","KfDriftSideV16Account","HealthCertV16Account","CloseProgressLedgerV16Account"]),
 (wrp, "percolator_prog::state", ["WrapperConfigV16","AssetOracleProfileV16","AssetControlSequencesV16","AssetRiskLimitsV17",
   "BackingDomainLedgerAccountV16","InsuranceLedgerAccountV16","PortfolioMatcherConfigV16","LpVaultRegistryV16","LpRedemptionV16",
   "LpRedemptionExtV22","VaultLpStateV18","VaultLpExtV19","BondTrancheV20","BondPositionV20","InsuranceUnitsV20","G9FeedAllowlistV22",
   "AssetVaultLpV18","AssetVaultLpDrawV18","AssetGrowthV19","NftRegistryV16"]),
]
out = ["use core::mem::{offset_of,size_of};","fn main(){"]
for path, mod, names in specs:
    txt = open(path).read()
    for n in names:
        m = re.search(r"pub struct %s\s*\{" % n, txt)
        if not m:
            print("MISSING", n, file=sys.stderr); continue
        i = m.end(); depth = 1; j = i
        while depth:
            c = txt[j]
            if c == '{': depth += 1
            elif c == '}': depth -= 1
            j += 1
        body = txt[i:j-1]
        body = re.sub(r"//[^\n]*", "", body)
        fields = re.findall(r"\bpub\s+([a-z_][a-z0-9_]*)\s*:", body)
        out.append('println!("SIZE {n} {{}}", size_of::<{mod}::{n}>());'.format(n=n, mod=mod))
        for f in fields:
            out.append('println!("OFF {n}.{f} {{}}", offset_of!({mod}::{n}, {f}));'.format(n=n, f=f, mod=mod))
out.append('println!("SIZE Market1024 {}", size_of::<percolator::Market<[u8;1024]>>());')
for c in ["VERSION","HEADER_LEN","WRAPPER_CONFIG_LEN","MARKET_GROUP_LEN","MARKET_ASSET_SLOT_LEN","PORTFOLIO_ACCOUNT_LEN","MARKET_GROUP_OFF","ASSET_ORACLE_WRAPPER_LEN","STAKE_POOL_LEN","PORTFOLIO_MATCHER_CONFIG_LEN","ASSET_ORACLE_PROFILE_LEN","ASSET_CONTROL_SEQUENCES_OFF","ASSET_RISK_LIMITS_OFF","ASSET_GROWTH_OFF","ASSET_VAULT_LP_DRAW_OFF","ASSET_VAULT_LP_OFF","STAKE_POOL_VERSION","STAKE_POOL_OFF_SLAB","STAKE_POOL_OFF_VAULT","STAKE_POOL_OFF_PERCOLATOR_PROGRAM","STAKE_POOL_OFF_MODE","STAKE_POOL_OFF_DISCRIMINATOR","STAKE_POOL_OFF_RISK_MODE","STAKE_POOL_OFF_VERSION","KIND_MARKET","KIND_PORTFOLIO","KIND_BACKING_DOMAIN_LEDGER","KIND_INSURANCE_LEDGER","KIND_LP_VAULT_REGISTRY","KIND_LP_REDEMPTION","KIND_NFT_REGISTRY","KIND_CLOSED_MARKET","KIND_VAULT_LP_STATE","KIND_VAULT_LP_EXT","KIND_BOND_TRANCHE","KIND_BOND_POSITION","KIND_INSURANCE_UNITS","KIND_G9_FEED_ALLOWLIST"]:
    out.append('println!("CONST {c} {{}}", percolator_prog::constants::{c});'.format(c=c))
out.append('println!("CONST V16_LAYOUT_DISCRIMINATOR {}", percolator::V16_LAYOUT_DISCRIMINATOR);')
out.append("}")
open(sys.argv[1], "w").write("\n".join(out) + "\n")
