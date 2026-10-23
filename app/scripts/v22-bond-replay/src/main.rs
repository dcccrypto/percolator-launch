use litesvm::LiteSVM;
use serde_json::Value;
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};
use spl_token::state::{Account as TokenAccount, AccountState, Mint};
use std::str::FromStr;

fn pk(v: &Value) -> Pubkey { Pubkey::from_str(v.as_str().unwrap()).unwrap() }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dump_path = &args[1];
    let wrapper_so = &args[2];
    let mode = args.get(3).map(|s| s.as_str()).unwrap_or("full");
    let dump: Value = serde_json::from_str(&std::fs::read_to_string(dump_path).unwrap()).unwrap();
    let wrapper = pk(&dump["wrapper"]);
    let stake = pk(&dump["stake"]);
    let payer = pk(&dump["payer"]);
    let mint = pk(&dump["mint"]);

    let mut svm = LiteSVM::new().with_sigverify(false).with_spl_programs();
    svm.add_program(wrapper, &std::fs::read(wrapper_so).unwrap());
    if let Some(stake_so) = args.get(5) { svm.add_program(stake, &std::fs::read(stake_so).unwrap()); }
    // clock: the app's harness slot
    let mut clock = svm.get_sysvar::<solana_sdk::clock::Clock>();
    clock.slot = 5_000;
    clock.unix_timestamp = 1_760_000_000;
    svm.set_sysvar(&clock);
    svm.airdrop(&payer, 1_000_000_000_000).unwrap();
    // collateral mint + the wallet's ATA with plenty of collateral
    let mut mint_data = vec![0u8; Mint::LEN];
    Mint::pack(Mint { mint_authority: COption::Some(payer), supply: 10_000_000_000_000, decimals: 6, is_initialized: true, freeze_authority: COption::None }, &mut mint_data).unwrap();
    svm.set_account(mint, Account { lamports: 10_000_000, data: mint_data, owner: spl_token::id(), executable: false, rent_epoch: 0 }).unwrap();
    let user_ata = spl_associated_token_account_addr(&payer, &mint);
    let mut ta = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(TokenAccount { mint, owner: payer, amount: 10_000_000_000_000, delegate: COption::None, state: AccountState::Initialized, is_native: COption::None, delegated_amount: 0, close_authority: COption::None }, &mut ta).unwrap();
    svm.set_account(user_ata, Account { lamports: 10_000_000, data: ta, owner: spl_token::id(), executable: false, rent_epoch: 0 }).unwrap();

    let mut ixs: Vec<Instruction> = vec![];
    ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(dump["computeUnitLimit"].as_u64().unwrap() as u32));
    ixs.push(ComputeBudgetInstruction::request_heap_frame(dump["heap"].as_u64().unwrap() as u32));
    let mut raw: Vec<(Pubkey, Vec<AccountMeta>, Vec<u8>)> = vec![];
    for ix in dump["instructions"].as_array().unwrap() {
        let program = pk(&ix["program"]);
        if program == stake && args.get(5).is_none() { continue; } // the stake program is skipped unless a stake .so is given as argv[5]
        let keys: Vec<AccountMeta> = ix["keys"].as_array().unwrap().iter().map(|k| {
            let key = pk(&k["pubkey"]);
            let s = k["signer"].as_bool().unwrap();
            if k["writable"].as_bool().unwrap() { AccountMeta::new(key, s) } else { AccountMeta::new_readonly(key, s) }
        }).collect();
        raw.push((program, keys, hex::decode(ix["data"].as_str().unwrap()).unwrap()));
    }
    let tag = |r: &(Pubkey, Vec<AccountMeta>, Vec<u8>)| if r.0 == wrapper { Some(r.2[0]) } else { None };
    match mode {
        "no-tail" => { // negative control: the seeds WITHOUT the bound-vault tail
            for r in raw.iter_mut() { if tag(r) == Some(75) { r.1.truncate(11); } }
        }
        "split" => { // negative control: the LP-share ATA and a seed land BETWEEN 94 and 107 (107 must then be refused)
            let i107 = raw.iter().position(|r| tag(r) == Some(107)).unwrap();
            let i75 = raw.iter().position(|r| tag(r) == Some(75)).unwrap();
            let seed = raw.remove(i75);
            let ata = raw.remove(i107 + 1); // the ATA create that follows 107
            raw.insert(i107, ata);
            raw.insert(i107 + 1, seed);
        }
        "short-portfolio" => { // negative control (wrapper f199054a): a portfolio created shorter than PORTFOLIO_ACCOUNT_LEN (10,603) must be refused
            for r in raw.iter_mut() {
                if r.0 == solana_sdk::system_program::id() && r.2.len() == 52 && r.2[..4] == [0, 0, 0, 0] && u64::from_le_bytes(r.2[12..20].try_into().unwrap()) == 10_603 {
                    r.2[12..20].copy_from_slice(&10_240u64.to_le_bytes());
                }
            }
        }
        _ => {}
    }
    // ENVIRONMENT ID SUBSTITUTION (not an app change): the devnet wrapper build pins the canonical vault-LP matcher
    // `DfTxJUT5...`; the app's configured matcher id is a different (older) address. Run the matcher binary at the
    // canonical id and re-point the app's matcher key, the matcher context's owner, and the matcher_delegate PDA.
    let canon = Pubkey::from_str("DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam").unwrap();
    if let Some(matcher_so) = args.get(4) {
        svm.add_program(canon, &std::fs::read(matcher_so).unwrap());
        let i94 = raw.iter().position(|r| tag(r) == Some(94)).unwrap();
        let old_matcher = raw[i94].1[8].pubkey;
        let (market, registry, lp, ctx, old_delegate) = (raw[i94].1[1].pubkey, raw[i94].1[2].pubkey, raw[i94].1[4].pubkey, raw[i94].1[9].pubkey, raw[i94].1[10].pubkey);
        let (new_delegate, _) = Pubkey::find_program_address(&[b"matcher", market.as_ref(), lp.as_ref(), registry.as_ref(), canon.as_ref(), ctx.as_ref()], &wrapper);
        let (chk, _) = Pubkey::find_program_address(&[b"matcher", market.as_ref(), lp.as_ref(), registry.as_ref(), old_matcher.as_ref(), ctx.as_ref()], &wrapper);
        println!("app delegate matches the app's own derivation: {}", chk == old_delegate);
        for r in raw.iter_mut() {
            for m in r.1.iter_mut() {
                if m.pubkey == old_matcher { m.pubkey = canon; }
                if m.pubkey == old_delegate { m.pubkey = new_delegate; }
            }
            if r.0 == solana_sdk::system_program::id() && r.2.len() == 52 && r.2[20..52] == old_matcher.to_bytes() {
                r.2[20..52].copy_from_slice(&canon.to_bytes());
            }
        }
    }
    // The app test harness prices rent as 1_000_000 + space; the real runtime needs the rent-exempt minimum.
    for r in raw.iter_mut() {
        if r.0 == solana_sdk::system_program::id() && r.2.len() == 52 && r.2[..4] == [0, 0, 0, 0] {
            let space = u64::from_le_bytes(r.2[12..20].try_into().unwrap()) as usize;
            let need = svm.minimum_balance_for_rent_exemption(space);
            let have = u64::from_le_bytes(r.2[4..12].try_into().unwrap());
            if have < need { r.2[4..12].copy_from_slice(&need.to_le_bytes()); }
        }
    }
    println!("mode={} instructions={}", mode, raw.len());
    for (p, k, d) in raw { ixs.push(Instruction { program_id: p, accounts: k, data: d }); }
    let tx = Transaction::new_unsigned(solana_sdk::message::Message::new(&ixs, Some(&payer)));
    let _ = Keypair::new();
    let res = svm.send_transaction(tx);
    match res {
        Ok(m) => {
            println!("LANDED compute_units_consumed={}", m.compute_units_consumed);
            for l in m.logs.iter().filter(|l| l.contains("failed") || l.contains("consumed")).take(40) { println!("  {}", l); }
            // state
            let market = pk(&dump["instructions"].as_array().unwrap().iter().find(|i| i["data"].as_str().unwrap().starts_with("6b") || i["data"].as_str().unwrap().starts_with("5e")).unwrap()["keys"][1]["pubkey"]);
            let (tranche, _) = Pubkey::find_program_address(&[b"bond_tranche", market.as_ref()], &wrapper);
            let has_bond = dump["instructions"].as_array().unwrap().iter().any(|i| i["data"].as_str().unwrap().starts_with("6b"));
            if !has_bond { println!("no bond tranche in this bundle"); println!("JSON_OK"); return; }
            let a = svm.get_account(&tranche).expect("tranche account missing");
            println!("tranche {} owner_ok={} len={} version={} kind={}", tranche, a.owner == wrapper, a.data.len(), u16::from_le_bytes([a.data[8], a.data[9]]), a.data[10]);
            // tranche record (v22-state BOND_TRANCHE_FIELD_OFF_V22, body at +16): dials as the wizard sent them, C_b = B = 0 (nothing deposited)
            let b = 16usize;
            let u16at = |o: usize| u16::from_le_bytes([a.data[b + o], a.data[b + o + 1]]);
            let u32at = |o: usize| u32::from_le_bytes(a.data[b + o..b + o + 4].try_into().unwrap());
            println!("tranche coupon_bps={} util_bonus={} cooldown_slots={} cap_bps={} market_group_ok={} c_b={:?} shares={:?}",
                u16at(104), u16at(106), u32at(108), u16at(112), a.data[b..b + 32] == market.to_bytes(),
                &a.data[b + 32..b + 48] == &[0u8; 16], &a.data[b + 48..b + 64] == &[0u8; 16]);
            // registry: bound flag (LP_VAULT_REGISTRY_BOUND_FLAG_OFF_P3 = 160) and the Earn seeds (LP mint supply)
            let seed75 = dump["instructions"].as_array().unwrap().iter().find(|i| i["data"].as_str().unwrap().starts_with("4b")).unwrap();
            let registry = pk(&seed75["keys"][2]["pubkey"]);
            let lp_mint = pk(&seed75["keys"][3]["pubkey"]);
            let r = svm.get_account(&registry).unwrap();
            println!("registry bound_flag={}", r.data[160]);
            let mintacc = svm.get_account(&lp_mint).unwrap();
            let supply = u64::from_le_bytes(mintacc.data[36..44].try_into().unwrap());
            println!("LP mint supply after the two seeds = {}", supply);
            let m = svm.get_account(&market).unwrap();
            println!("market len={} version={}", m.data.len(), u16::from_le_bytes([m.data[8], m.data[9]]));
            // lot pricing: profile byte +19 (lot_exp) of asset 0 (slot 0 starts at 592 + 806) and the per-lot effective price (engine slot = slot + 1024, +25)
            let slot0 = 592 + 806;
            println!("market profile lot_exp={} effective_price_e6_per_lot={}", m.data[slot0 + 19], u64::from_le_bytes(m.data[slot0 + 1024 + 25..slot0 + 1024 + 33].try_into().unwrap()));
            let init = dump["instructions"].as_array().unwrap().iter().find(|i| i["data"].as_str().unwrap().starts_with("00") && i["program"].as_str().unwrap() == dump["wrapper"].as_str().unwrap()).unwrap();
            let idata = hex::decode(init["data"].as_str().unwrap()).unwrap();
            println!("InitMarket data len={} (trailer tail bytes: {})", idata.len(), hex::encode(&idata[idata.len().saturating_sub(40)..]));
            println!("JSON_OK");
        }
        Err(e) => {
            println!("FAILED err={:?}", e.err);
            for l in e.meta.logs.iter().rev().take(14).collect::<Vec<_>>().into_iter().rev() { println!("  {}", l); }
        }
    }
}

fn spl_associated_token_account_addr(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ata_prog = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap();
    Pubkey::find_program_address(&[wallet.as_ref(), spl_token::id().as_ref(), mint.as_ref()], &ata_prog).0
}
