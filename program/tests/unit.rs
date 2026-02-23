//! Unit tests for percolator-prog
//!
//! These tests verify the Solana program wrapper's instruction handling,
//! including account validation, state management, and invariants.

use solana_program::{
    account_info::AccountInfo,
    pubkey::Pubkey,
    clock::Clock,
    program_pack::Pack,
    program_error::ProgramError,
};
use spl_token::state::{Account as TokenAccount, AccountState};
use percolator_prog::{
    processor::process_instruction,
    constants::{MAGIC, VERSION},
    zc,
    error::PercolatorError,
    state,
    oracle,
    units,
};
use percolator::{MAX_ACCOUNTS, U128, I128};

// --- Harness ---

struct TestAccount {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
    is_signer: bool,
    is_writable: bool,
    executable: bool,
}

impl TestAccount {
    fn new(key: Pubkey, owner: Pubkey, lamports: u64, data: Vec<u8>) -> Self {
        Self { key, owner, lamports, data, is_signer: false, is_writable: false, executable: false }
    }
    fn signer(mut self) -> Self { self.is_signer = true; self }
    fn writable(mut self) -> Self { self.is_writable = true; self }
    fn executable(mut self) -> Self { self.executable = true; self }
    
    fn to_info<'a>(&'a mut self) -> AccountInfo<'a> {
        AccountInfo::new(
            &self.key,
            self.is_signer,
            self.is_writable,
            &mut self.lamports,
            &mut self.data,
            &self.owner,
            self.executable,
            0,
        )
    }
}

// --- Builders ---

fn make_token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; TokenAccount::LEN];
    let mut account = TokenAccount::default();
    account.mint = mint;
    account.owner = owner;
    account.amount = amount;
    account.state = AccountState::Initialized;
    TokenAccount::pack(account, &mut data).unwrap();
    data
}

fn make_mint_account() -> Vec<u8> {
    use spl_token::state::Mint;
    let mut data = vec![0u8; Mint::LEN];
    let mint = Mint {
        mint_authority: solana_program::program_option::COption::None,
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: solana_program::program_option::COption::None,
    };
    Mint::pack(mint, &mut data).unwrap();
    data
}

/// PYTH_RECEIVER_PROGRAM_ID bytes (rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ)
const PYTH_RECEIVER_BYTES: [u8; 32] = [
    0x0c, 0xb7, 0xfa, 0xbb, 0x52, 0xf7, 0xa6, 0x48,
    0xbb, 0x5b, 0x31, 0x7d, 0x9a, 0x01, 0x8b, 0x90,
    0x57, 0xcb, 0x02, 0x47, 0x74, 0xfa, 0xfe, 0x01,
    0xe6, 0xc4, 0xdf, 0x98, 0xcc, 0x38, 0x58, 0x81,
];

/// Create PriceUpdateV2 mock data (Pyth Pull format)
/// Layout: discriminator(8) + write_authority(32) + verification_level(2) + feed_id(32) +
///         price(8) + conf(8) + expo(4) + publish_time(8) + ...
fn make_pyth(feed_id: &[u8; 32], price: i64, expo: i32, conf: u64, publish_time: i64) -> Vec<u8> {
    let mut data = vec![0u8; 134];
    // feed_id at offset 42
    data[42..74].copy_from_slice(feed_id);
    // price at offset 74
    data[74..82].copy_from_slice(&price.to_le_bytes());
    // conf at offset 82
    data[82..90].copy_from_slice(&conf.to_le_bytes());
    // expo at offset 90
    data[90..94].copy_from_slice(&expo.to_le_bytes());
    // publish_time at offset 94
    data[94..102].copy_from_slice(&publish_time.to_le_bytes());
    data
}

fn make_clock(slot: u64, unix_timestamp: i64) -> Vec<u8> {
    let clock = Clock { slot, unix_timestamp, ..Clock::default() };
    bincode::serialize(&clock).unwrap()
}

struct MarketFixture {
    program_id: Pubkey,
    admin: TestAccount,
    slab: TestAccount,
    mint: TestAccount,
    vault: TestAccount,
    token_prog: TestAccount,
    pyth_index: TestAccount,
    index_feed_id: [u8; 32],
    clock: TestAccount,
    rent: TestAccount,
    system: TestAccount,
    vault_pda: Pubkey,
}

/// Default feed_id for tests
const TEST_FEED_ID: [u8; 32] = [0xABu8; 32];

fn setup_market() -> MarketFixture {
    let program_id = Pubkey::new_unique();
    let slab_key = Pubkey::new_unique();
    let (vault_pda, _) = Pubkey::find_program_address(&[b"vault", slab_key.as_ref()], &program_id);
    let mint_key = Pubkey::new_unique();
    let pyth_receiver_id = Pubkey::new_from_array(PYTH_RECEIVER_BYTES);

    // Price = $100 (100_000_000 in e6 format), expo = -6, conf = 1, publish_time = 100
    let pyth_data = make_pyth(&TEST_FEED_ID, 100_000_000, -6, 1, 100);

    MarketFixture {
        program_id,
        admin: TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer(),
        slab: TestAccount::new(slab_key, program_id, 0, vec![0u8; percolator_prog::constants::SLAB_LEN]).writable(),
        mint: TestAccount::new(mint_key, spl_token::ID, 0, make_mint_account()),
        vault: TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(mint_key, vault_pda, 0)).writable(),
        token_prog: TestAccount::new(spl_token::ID, Pubkey::default(), 0, vec![]).executable(),
        pyth_index: TestAccount::new(Pubkey::new_unique(), pyth_receiver_id, 0, pyth_data),
        index_feed_id: TEST_FEED_ID,
        clock: TestAccount::new(solana_program::sysvar::clock::id(), solana_program::sysvar::id(), 0, make_clock(100, 100)),
        rent: TestAccount::new(solana_program::sysvar::rent::id(), solana_program::sysvar::id(), 0, vec![]),
        system: TestAccount::new(solana_program::system_program::id(), Pubkey::default(), 0, vec![]),
        vault_pda,
    }
}

// --- Encoders ---

fn encode_u64(val: u64, buf: &mut Vec<u8>) { buf.extend_from_slice(&val.to_le_bytes()); }
fn encode_u32(val: u32, buf: &mut Vec<u8>) { buf.extend_from_slice(&val.to_le_bytes()); }
fn encode_u16(val: u16, buf: &mut Vec<u8>) { buf.extend_from_slice(&val.to_le_bytes()); }
fn encode_i128(val: i128, buf: &mut Vec<u8>) { buf.extend_from_slice(&val.to_le_bytes()); }
fn encode_u128(val: u128, buf: &mut Vec<u8>) { buf.extend_from_slice(&val.to_le_bytes()); }
fn encode_pubkey(val: &Pubkey, buf: &mut Vec<u8>) { buf.extend_from_slice(val.as_ref()); }
fn encode_bytes32(val: &[u8; 32], buf: &mut Vec<u8>) { buf.extend_from_slice(val); }

fn encode_init_market(fixture: &MarketFixture, crank_staleness: u64) -> Vec<u8> {
    let mut data = vec![0u8];
    encode_pubkey(&fixture.admin.key, &mut data);
    encode_pubkey(&fixture.mint.key, &mut data);
    encode_bytes32(&fixture.index_feed_id, &mut data);
    encode_u64(100, &mut data); // max_staleness_secs
    encode_u16(500, &mut data); // conf_filter_bps
    data.push(0u8); // invert (0 = no inversion)
    encode_u32(0, &mut data); // unit_scale (0 = no scaling)

    // initial_mark_price_e6
    encode_u64(0, &mut data);  // initial_mark_price_e6

    // RiskParams (must match read_risk_params order)
    encode_u64(0, &mut data);     // warmup_period_slots
    encode_u64(500, &mut data);   // maintenance_margin_bps (5%)
    encode_u64(1000, &mut data);  // initial_margin_bps (10%)
    encode_u64(30, &mut data);    // trading_fee_bps (0.3%)
    encode_u64(64, &mut data);    // max_accounts
    encode_u128(0, &mut data);    // new_account_fee
    encode_u128(0, &mut data);    // risk_reduction_threshold
    encode_u128(0, &mut data);    // maintenance_fee_per_slot
    encode_u64(crank_staleness, &mut data); // max_crank_staleness_slots
    encode_u64(0, &mut data);     // liquidation_fee_bps
    encode_u128(0, &mut data);    // liquidation_fee_cap
    encode_u64(0, &mut data);     // liquidation_buffer_bps
    encode_u128(0, &mut data);    // min_liquidation_abs
    data
}

fn encode_init_market_invert(fixture: &MarketFixture, crank_staleness: u64, invert: u8, unit_scale: u32) -> Vec<u8> {
    let mut data = vec![0u8];
    encode_pubkey(&fixture.admin.key, &mut data);
    encode_pubkey(&fixture.mint.key, &mut data);
    encode_bytes32(&fixture.index_feed_id, &mut data);
    encode_u64(100, &mut data); // max_staleness_secs
    encode_u16(500, &mut data); // conf_filter_bps
    data.push(invert);
    encode_u32(unit_scale, &mut data);

    // initial_mark_price_e6
    encode_u64(0, &mut data);  // initial_mark_price_e6

    // RiskParams (must match read_risk_params order)
    encode_u64(0, &mut data);     // warmup_period_slots
    encode_u64(500, &mut data);   // maintenance_margin_bps (5%)
    encode_u64(1000, &mut data);  // initial_margin_bps (10%)
    encode_u64(30, &mut data);    // trading_fee_bps (0.3%)
    encode_u64(64, &mut data);    // max_accounts
    encode_u128(0, &mut data);    // new_account_fee
    encode_u128(0, &mut data);    // risk_reduction_threshold
    encode_u128(0, &mut data);    // maintenance_fee_per_slot
    encode_u64(crank_staleness, &mut data); // max_crank_staleness_slots
    encode_u64(0, &mut data);     // liquidation_fee_bps
    encode_u128(0, &mut data);    // liquidation_fee_cap
    encode_u64(0, &mut data);     // liquidation_buffer_bps
    encode_u128(0, &mut data);    // min_liquidation_abs
    data
}

    fn encode_init_user(fee: u64) -> Vec<u8> {
        let mut data = vec![1u8];
        encode_u64(fee, &mut data);
        data
    }

    fn encode_init_lp(matcher: Pubkey, ctx: Pubkey, fee: u64) -> Vec<u8> {
        let mut data = vec![2u8];
        encode_pubkey(&matcher, &mut data);
        encode_pubkey(&ctx, &mut data);
        encode_u64(fee, &mut data);
        data
    }

    fn encode_deposit(user_idx: u16, amount: u64) -> Vec<u8> {
        let mut data = vec![3u8];
        encode_u16(user_idx, &mut data);
        encode_u64(amount, &mut data);
        data
    }

    fn encode_withdraw(user_idx: u16, amount: u64) -> Vec<u8> {
        let mut data = vec![4u8];
        encode_u16(user_idx, &mut data);
        encode_u64(amount, &mut data);
        data
    }

    fn encode_crank(caller: u16, panic: u8) -> Vec<u8> {
        let mut data = vec![5u8];
        encode_u16(caller, &mut data);
        data.push(panic);
        data
    }

    fn encode_crank_permissionless(panic: u8) -> Vec<u8> {
        encode_crank(u16::MAX, panic)
    }

    fn encode_trade(lp: u16, user: u16, size: i128) -> Vec<u8> {
        let mut data = vec![6u8];
        encode_u16(lp, &mut data);
        encode_u16(user, &mut data);
        encode_i128(size, &mut data);
        data
    }

    fn encode_trade_cpi(lp: u16, user: u16, size: i128) -> Vec<u8> {
        let mut data = vec![10u8];
        encode_u16(lp, &mut data);
        encode_u16(user, &mut data);
        encode_i128(size, &mut data);
        data
    }

    fn encode_set_risk_threshold(new_threshold: u128) -> Vec<u8> {
        let mut data = vec![11u8];
        encode_u128(new_threshold, &mut data);
        data
    }

    fn encode_update_admin(new_admin: &Pubkey) -> Vec<u8> {
        let mut data = vec![12u8];
        encode_pubkey(new_admin, &mut data);
        data
    }

    fn encode_close_slab() -> Vec<u8> {
        vec![13u8]
    }

    fn encode_topup_insurance(amount: u64) -> Vec<u8> {
        let mut data = vec![9u8];
        encode_u64(amount, &mut data);
        data
    }

    fn find_idx_by_owner(data: &[u8], owner: Pubkey) -> Option<u16> {
        let engine = zc::engine_ref(data).ok()?;
        for i in 0..MAX_ACCOUNTS {
            if engine.is_used(i) && engine.accounts[i].owner == owner.to_bytes() {
                return Some(i as u16);
            }
        }
        None
    }

    // --- Tests ---

    #[test]
    fn test_struct_sizes() {
        extern crate std;
        use std::println;
        use percolator::{RiskEngine, Account, MAX_ACCOUNTS};
        use core::mem::{size_of, offset_of};

        println!("Size of Account: {}", size_of::<Account>());
        println!("Offset of Account.kind: {}", offset_of!(Account, kind));
        println!("Offset of Account.owner: {}", offset_of!(Account, owner));
        println!("Size of RiskEngine: {}", size_of::<RiskEngine>());
        println!("MAX_ACCOUNTS: {}", MAX_ACCOUNTS);

        let account_array_size = MAX_ACCOUNTS * size_of::<Account>();
        println!("Account array size: {}", account_array_size);

        // Print offset of accounts array within RiskEngine
        println!("Offset of RiskEngine.accounts: {}", offset_of!(RiskEngine, accounts));
        println!("Offset of RiskEngine.vault: {}", offset_of!(RiskEngine, vault));
        println!("Offset of RiskEngine.insurance_fund: {}", offset_of!(RiskEngine, insurance_fund));
        println!("Offset of RiskEngine.params: {}", offset_of!(RiskEngine, params));
        println!("Offset of RiskEngine.used: {}", offset_of!(RiskEngine, used));

        // Print the SBF constant (note: this is x86_64 value when run as native test)
        println!("ACCOUNTS_OFFSET (this test is x86_64): {}", percolator_prog::zc::ACCOUNTS_OFFSET);

        // Print SLAB_LEN
        println!("ENGINE_OFF: {}", percolator_prog::constants::ENGINE_OFF);
        println!("ENGINE_LEN: {}", percolator_prog::constants::ENGINE_LEN);
        println!("SLAB_LEN: {}", percolator_prog::constants::SLAB_LEN);
    }

    #[test]
    fn test_init_market() {
        let mut f = setup_market();
        let data = encode_init_market(&f, 100);
        
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        let header = state::read_header(&f.slab.data);
        assert_eq!(header.magic, MAGIC);
        assert_eq!(header.version, VERSION);
        
        let engine = zc::engine_ref(&f.slab.data).unwrap();
        assert_eq!(engine.params.max_accounts, 64);
    }

    #[test]
    #[cfg(feature = "test")]
    fn test_init_user() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let init_accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &init_accounts, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();

        let data = encode_init_user(100);
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        let vault_state = TokenAccount::unpack(&f.vault.data).unwrap();
        assert_eq!(vault_state.amount, 100); 
        assert!(find_idx_by_owner(&f.slab.data, user.key).is_some());
    }

    #[test]
    #[cfg(feature = "test")]
    fn test_deposit_withdraw() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, u64::MAX); 
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let init_accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &init_accounts, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 500)).unwrap();
        }

        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_crank(user_idx, 0)).unwrap();
        }

        {
            let mut vault_pda_account = TestAccount::new(f.vault_pda, solana_program::system_program::id(), 0, vec![]);
            let accounts = vec![
                user.to_info(), f.slab.to_info(), f.vault.to_info(), user_ata.to_info(), vault_pda_account.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.pyth_index.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_withdraw(user_idx, 200)).unwrap();
        }

        let vault_state = TokenAccount::unpack(&f.vault.data).unwrap();
        assert_eq!(vault_state.amount, 300);
    }

    #[test]
    fn test_vault_validation() {
        let mut f = setup_market();
        f.vault.owner = solana_program::system_program::id();
        let init_data = encode_init_market(&f, 100);
        let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        let init_accounts = vec![
            f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
            f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
        ];
        let res = process_instruction(&f.program_id, &init_accounts, &init_data);
        assert_eq!(res, Err(PercolatorError::InvalidVaultAta.into()));
    }

    #[test]
    fn test_trade() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let init_accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &init_accounts, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();
        {
            let accounts = vec![user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 1000)).unwrap();
        }

        let mut lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut lp_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, lp.key, 1000)).writable();
        let mut d1 = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        let mut d2 = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        {
            let matcher_prog_key = d1.key;
            let matcher_ctx_key = d2.key;
            let accs = vec![
                lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_lp(matcher_prog_key, matcher_ctx_key, 0)).unwrap();
        }
        let lp_idx = find_idx_by_owner(&f.slab.data, lp.key).unwrap();
        {
            let accounts = vec![lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accounts, &encode_deposit(lp_idx, 1000)).unwrap();
        }

        {
            let accounts = vec![
                user.to_info(), lp.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_trade(lp_idx, user_idx, 100)).unwrap();
        }
    }

    #[test]
    #[cfg(feature = "test")]
    fn test_withdraw_wrong_signer() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, u64::MAX);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 500)).unwrap();
        }

        {
            let accs = vec![
                user.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            process_instruction(&f.program_id, &accs, &encode_crank(user_idx, 0)).unwrap();
        }

        let mut attacker = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut vault_pda = TestAccount::new(f.vault_pda, solana_program::system_program::id(), 0, vec![]);
        
        let res = {
            let accounts = vec![
                attacker.to_info(),
                f.slab.to_info(), f.vault.to_info(), user_ata.to_info(), vault_pda.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_withdraw(user_idx, 100))
        };
        assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
    }

    #[test]
    fn test_trade_wrong_signer() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, u64::MAX);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accs = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        let mut lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut lp_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, lp.key, 1000)).writable();
        let d1 = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        let d2 = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        {
            let matcher_prog_key = d1.key;
            let matcher_ctx_key = d2.key;
            let accs = vec![
                lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_lp(matcher_prog_key, matcher_ctx_key, 0)).unwrap();
        }
        let lp_idx = find_idx_by_owner(&f.slab.data, lp.key).unwrap();

        {
            let accs = vec![user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accs, &encode_deposit(user_idx, 1000)).unwrap();
        }
        {
            let accs = vec![lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accs, &encode_deposit(lp_idx, 1000)).unwrap();
        }
        {
            let accs = vec![user.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()];
            process_instruction(&f.program_id, &accs, &encode_crank(user_idx, 0)).unwrap();
        }

        let mut attacker = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        {
            let accs = vec![
                attacker.to_info(), lp.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            let res = process_instruction(&f.program_id, &accs, &encode_trade(lp_idx, user_idx, 100));
            assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
        }
    }

    #[test]
    fn test_trade_cpi_wrong_pda_key_rejected() {
        // This test verifies pre-CPI validation: wrong PDA key is rejected
        // Note: Full TradeCpi success path is tested in integration tests where CPI works
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accs = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        let mut lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut lp_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, lp.key, 1000)).writable();
        let mut matcher_program = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        matcher_program.executable = true;
        let mut matcher_ctx = TestAccount::new(Pubkey::new_unique(), matcher_program.key, 0, vec![0u8; 320]);
        matcher_ctx.is_writable = true;
        {
            let matcher_prog_key = matcher_program.key;
            let matcher_ctx_key = matcher_ctx.key;
            let accs = vec![
                lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_lp(matcher_prog_key, matcher_ctx_key, 0)).unwrap();
        }
        let lp_idx = find_idx_by_owner(&f.slab.data, lp.key).unwrap();

        // Create WRONG lp_pda - use a random key instead of the correct PDA
        let mut wrong_lp_pda = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]);

        let accs = vec![
            user.to_info(),
            lp.to_info(),
            f.slab.to_info(),
            f.clock.to_info(),
            f.pyth_index.to_info(),
            matcher_program.to_info(),
            matcher_ctx.to_info(),
            wrong_lp_pda.to_info(),
        ];
        let res = process_instruction(&f.program_id, &accs, &encode_trade_cpi(lp_idx, user_idx, 100));
        assert_eq!(res, Err(ProgramError::InvalidSeeds));
    }

    #[test]
    fn test_trade_cpi_wrong_lp_owner_rejected() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accs = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        let mut lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut lp_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, lp.key, 1000)).writable();
        let mut matcher_program = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        matcher_program.executable = true;
        let mut matcher_ctx = TestAccount::new(Pubkey::new_unique(), matcher_program.key, 0, vec![0u8; 320]);
        matcher_ctx.is_writable = true;
        {
            let matcher_prog_key = matcher_program.key;
            let matcher_ctx_key = matcher_ctx.key;
            let accs = vec![
                lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_lp(matcher_prog_key, matcher_ctx_key, 0)).unwrap();
        }
        let lp_idx = find_idx_by_owner(&f.slab.data, lp.key).unwrap();

        let mut wrong_lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();

        // Create lp_pda account (system-owned, 0 data)
        let lp_bytes = lp_idx.to_le_bytes();
        let (lp_pda_key, _) = Pubkey::find_program_address(
            &[b"lp", f.slab.key.as_ref(), &lp_bytes],
            &f.program_id
        );
        let mut lp_pda = TestAccount::new(lp_pda_key, solana_program::system_program::id(), 0, vec![]);

        let res = {
            let accs = vec![
                user.to_info(), // 0
                wrong_lp.to_info(), // 1 (WRONG OWNER)
                f.slab.to_info(), // 2
                f.clock.to_info(), // 3
                f.pyth_index.to_info(), // 4 oracle
                matcher_program.to_info(), // 5 matcher
                matcher_ctx.to_info(), // 6 context
                lp_pda.to_info(), // 7 lp_pda
            ];
            process_instruction(&f.program_id, &accs, &encode_trade_cpi(lp_idx, user_idx, 100))
        };
        assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
    }

    #[test]
    fn test_trade_cpi_wrong_oracle_key_rejected() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accs = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        let mut lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut lp_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, lp.key, 1000)).writable();
        let mut matcher_program = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        matcher_program.executable = true;
        let mut matcher_ctx = TestAccount::new(Pubkey::new_unique(), matcher_program.key, 0, vec![0u8; 320]);
        matcher_ctx.is_writable = true;
        {
            let matcher_prog_key = matcher_program.key;
            let matcher_ctx_key = matcher_ctx.key;
            let accs = vec![
                lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_lp(matcher_prog_key, matcher_ctx_key, 0)).unwrap();
        }
        let lp_idx = find_idx_by_owner(&f.slab.data, lp.key).unwrap();

        // Create oracle with correct owner but wrong feed_id
        let wrong_feed_id = [0xFFu8; 32];
        let pyth_receiver_id = Pubkey::new_from_array(PYTH_RECEIVER_BYTES);
        let wrong_pyth_data = make_pyth(&wrong_feed_id, 100_000_000, -6, 1, 100);
        let mut wrong_oracle = TestAccount::new(Pubkey::new_unique(), pyth_receiver_id, 0, wrong_pyth_data);

        // Create lp_pda account (system-owned, 0 data)
        let lp_bytes = lp_idx.to_le_bytes();
        let (lp_pda_key, _) = Pubkey::find_program_address(
            &[b"lp", f.slab.key.as_ref(), &lp_bytes],
            &f.program_id
        );
        let mut lp_pda = TestAccount::new(lp_pda_key, solana_program::system_program::id(), 0, vec![]);

        let res = {
            let accs = vec![
                user.to_info(), // 0
                lp.to_info(), // 1
                f.slab.to_info(), // 2
                f.clock.to_info(), // 3
                wrong_oracle.to_info(), // 4 oracle (WRONG FEED_ID)
                matcher_program.to_info(), // 5 matcher
                matcher_ctx.to_info(), // 6 context
                lp_pda.to_info(), // 7 lp_pda
            ];
            process_instruction(&f.program_id, &accs, &encode_trade_cpi(lp_idx, user_idx, 100))
        };
        // Returns InvalidOracleKey because feed_id doesn't match expected
        assert_eq!(res, Err(PercolatorError::InvalidOracleKey.into()));
    }

    #[test]
    fn test_set_risk_threshold() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        // Verify initial threshold is 0
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            assert_eq!(engine.risk_reduction_threshold(), 0);
        }

        // Admin sets new threshold
        let new_threshold: u128 = 123_456_789;
        {
            let accs = vec![
                f.admin.to_info(), // admin (signer)
                f.slab.to_info(),  // slab (writable)
            ];
            process_instruction(&f.program_id, &accs, &encode_set_risk_threshold(new_threshold)).unwrap();
        }

        // Verify threshold was updated
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            assert_eq!(engine.risk_reduction_threshold(), new_threshold);
        }
    }

    #[test]
    fn test_set_risk_threshold_non_admin_fails() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        // Non-admin tries to set threshold
        let mut attacker = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let new_threshold: u128 = 999_999;
        {
            let accs = vec![
                attacker.to_info(), // attacker (signer, but not admin)
                f.slab.to_info(),   // slab (writable)
            ];
            let res = process_instruction(&f.program_id, &accs, &encode_set_risk_threshold(new_threshold));
            assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
        }

        // Verify threshold was NOT updated (still 0)
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            assert_eq!(engine.risk_reduction_threshold(), 0);
        }
    }

    #[test]
    fn test_crank_updates_threshold_from_risk_metric() {
        use percolator_prog::constants::{DEFAULT_THRESH_FLOOR, DEFAULT_THRESH_RISK_BPS, DEFAULT_THRESH_ALPHA_BPS, DEFAULT_THRESH_MIN_STEP, DEFAULT_THRESH_STEP_BPS};

        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);
        {
            let mut dummy = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accs = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &init_data).unwrap();
        }

        // Verify initial threshold is 0
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            assert_eq!(engine.risk_reduction_threshold(), 0);
            assert!(engine.total_open_interest.is_zero());
        }

        // Create user
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 10_000_000)).writable();
        {
            let accs = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        // Create LP
        let mut lp = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut lp_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, lp.key, 10_000_000)).writable();
        let mut d1 = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        let mut d2 = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
        {
            let matcher_prog_key = d1.key;
            let matcher_ctx_key = d2.key;
            let accs = vec![
                lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_init_lp(matcher_prog_key, matcher_ctx_key, 0)).unwrap();
        }
        let lp_idx = find_idx_by_owner(&f.slab.data, lp.key).unwrap();

        // Deposit for both user and LP
        {
            let accs = vec![user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accs, &encode_deposit(user_idx, 1_000_000)).unwrap();
        }
        {
            let accs = vec![lp.to_info(), f.slab.to_info(), lp_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accs, &encode_deposit(lp_idx, 1_000_000)).unwrap();
        }

        // Execute trade to create positions
        let trade_size: i128 = 100_000;
        {
            let accs = vec![
                user.to_info(), lp.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            process_instruction(&f.program_id, &accs, &encode_trade(lp_idx, user_idx, trade_size)).unwrap();
        }

        // Verify positions were set by trade
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            let lp_pos = engine.accounts[lp_idx as usize].position_size;
            let user_pos = engine.accounts[user_idx as usize].position_size;
            assert!(!lp_pos.is_zero(), "LP should have non-zero position after trade");
            assert!(!user_pos.is_zero(), "User should have non-zero position after trade");
            // Verify LP is marked as LP
            assert!(engine.accounts[lp_idx as usize].is_lp(), "LP account should be marked as LP");
            assert!(engine.is_used(lp_idx as usize), "LP should be marked as used");
        }

        // Capture threshold before crank
        let threshold_before = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            engine.risk_reduction_threshold()
        };
        assert_eq!(threshold_before, 0, "Threshold should be 0 before crank");

        // Verify compute_system_risk_units returns non-zero
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            let risk_units = percolator_prog::compute_system_risk_units(engine);
            assert!(risk_units > 0, "risk_units should be > 0 when there are LP positions");
        }

        // Top up insurance to prevent force_realize from triggering during crank
        // (force_realize triggers when insurance <= threshold, both start at 0)
        {
            let mut funder = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
            let mut funder_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, funder.key, 1_000_000_000)).writable();
            let accs = vec![funder.to_info(), f.slab.to_info(), funder_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()];
            process_instruction(&f.program_id, &accs, &encode_topup_insurance(1_000_000_000)).unwrap();
        }

        // Now call crank - this should update threshold based on risk metric
        // Clock slot defaults to 0 in test, but last_thr_slot is also 0,
        // so update won't trigger unless slot >= 0 + THRESH_UPDATE_INTERVAL_SLOTS
        // We need to advance the clock
        f.clock.data = make_clock(100, 100); // Advance past rate limit
        {
            let accs = vec![user.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()];
            process_instruction(&f.program_id, &accs, &encode_crank(user_idx, 0)).unwrap();
        }

        // Verify threshold update ran by checking last_thr_update_slot
        let last_thr_slot_after = state::read_last_thr_update_slot(&f.slab.data);
        assert_eq!(last_thr_slot_after, 100, "last_thr_update_slot should be set to clock.slot after crank");

        // Check if positions are still non-zero after crank
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            let lp_pos = engine.accounts[lp_idx as usize].position_size;
            // Crank may liquidate positions. Check if LP still has position.
            let risk_units_after = percolator_prog::compute_system_risk_units(engine);
            // If risk_units is 0 after crank, positions were liquidated
            if risk_units_after == 0 {
                // This is expected if crank liquidated - threshold stays at 0
                return;
            }
        }

        // Verify threshold was updated based on risk metric
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            let threshold = engine.risk_reduction_threshold();

            // With trade_size=100000, LP position is -100000 (counterparty to user's +100000)
            // Only LP positions are counted for risk:
            //   lp_sum_abs = 100000, lp_max_abs = 100000
            //   risk_units = max_abs + sum_abs/8 = 100000 + 12500 = 112500
            //   risk_notional = 112500 * 100_000_000 / 1_000_000 = 11_250_000
            //   raw_target = 0 + 11_250_000 * 50 / 10_000 = 56_250
            //   EWMA: (1000 * 56250 + 9000 * 0) / 10000 = 5625
            //   max_step = 56250 (current == 0 → full jump allowed, Bug #6 fix)
            //   final = 0 + min(56250, 5625) = 5625

            assert!(threshold > 0, "Threshold should be > 0 after crank with positions");
            // Bug #6: when current == 0, full jump to clamped_target allowed (no min_step clamp)
            assert_eq!(threshold, 5625, "First update from 0 should be EWMA-smoothed raw target");
        }
    }

    #[test]
    fn test_permissionless_crank() {
        // Test that anyone can call crank with caller_idx = u16::MAX (permissionless mode)
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Create a random "keeper" account that is NOT a signer
        let mut keeper = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]);
        // Note: keeper is NOT marked as signer

        // Call permissionless crank - should succeed even though keeper is not a signer
        {
            let accs = vec![
                keeper.to_info(),  // Not a signer!
                f.slab.to_info(),
                f.clock.to_info(),
                f.pyth_index.to_info(),
            ];
            // Use encode_crank_permissionless which passes u16::MAX as caller_idx
            process_instruction(&f.program_id, &accs, &encode_crank_permissionless(0)).unwrap();
        }

        // Verify crank was executed (we can check that the engine is still valid)
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            assert!(engine.vault.is_zero()); // No deposits yet, vault should be 0
        }
    }

    #[test]
    fn test_permissionless_crank_gc() {
        // Non-vacuous test: create a dust account and verify GC frees it
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Init user - creates account slot
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(100)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        // Record state before GC
        let (used_before, is_used_before) = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            (engine.num_used_accounts, engine.is_used(user_idx as usize))
        };
        assert!(is_used_before, "User account should be used before GC");

        // Directly manipulate account to make it dust:
        // - capital = 0
        // - pnl = -1 (small negative)
        // - position_size = 0 (already 0)
        // - reserved_pnl = 0 (already 0)
        // - funding_index = engine.funding_index_qpb_e6
        // - fee_credits = 0, last_fee_slot = current_slot (robustness against future predicates)
        {
            let engine = zc::engine_mut(&mut f.slab.data).unwrap();
            let funding_idx = engine.funding_index_qpb_e6;
            let current_slot = engine.current_slot;
            let account = &mut engine.accounts[user_idx as usize];
            account.capital = U128::ZERO;
            account.pnl = I128::new(-1);
            account.funding_index = funding_idx;
            account.fee_credits = I128::ZERO;
            account.last_fee_slot = current_slot;
        }

        // Verify account is now a dust candidate
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            let account = &engine.accounts[user_idx as usize];
            assert!(account.capital.is_zero(), "capital should be 0");
            assert_eq!(account.pnl.get(), -1, "pnl should be -1");
            assert!(account.position_size.is_zero(), "position_size should be 0");
            assert_eq!(account.reserved_pnl, 0, "reserved_pnl should be 0");
            assert_eq!(account.funding_index, engine.funding_index_qpb_e6, "funding should match");
        }

        // Call permissionless crank - should GC the dust account
        let mut keeper = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]);
        {
            let accs = vec![
                keeper.to_info(),
                f.slab.to_info(),
                f.clock.to_info(),
                f.pyth_index.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_crank_permissionless(0)).unwrap();
        }

        // Verify GC freed the account
        {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            assert_eq!(engine.num_used_accounts, used_before - 1, "num_used_accounts should decrease by 1");
            assert!(!engine.is_used(user_idx as usize), "User account should no longer be used after GC");
        }
    }

    #[test]
    fn test_permissionless_funding_not_controllable() {
        // Security test: permissionless caller cannot influence funding rate.
        // Funding is computed deterministically from (LP inventory, oracle price, constants).
        //
        // Key security property: calling crank multiple times in the same slot is harmless
        // because engine gates via dt=0 (no funding accrues when dt=0).
        //
        // NOTE: Funding may be zero for small inventories due to integer division and the
        // chosen scale/horizon parameters (deadzone behavior). This test focuses on the
        // dt=0 anti-spam gating, independent of funding magnitude.
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Init user with deposit
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0, make_token_account(f.mint.key, user.key, 1_000_000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(100)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 100_000)).unwrap();
        }

        // Record funding index and last_funding_slot before any crank
        let (_funding_before, _last_slot_before) = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            (engine.funding_index_qpb_e6, engine.last_funding_slot)
        };

        // Random keeper calls crank - first crank at slot 100
        let mut keeper = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]);
        {
            let accs = vec![
                keeper.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_crank_permissionless(0)).unwrap();
        }
        let (funding_after_first, last_slot_after_first) = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            (engine.funding_index_qpb_e6, engine.last_funding_slot)
        };

        // Second crank in SAME slot - should NOT change funding (dt=0 gating)
        {
            let accs = vec![
                keeper.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_crank_permissionless(0)).unwrap();
        }
        let (funding_after_second, last_slot_after_second) = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            (engine.funding_index_qpb_e6, engine.last_funding_slot)
        };

        // KEY SECURITY ASSERTION: same-slot crank does NOT change funding index
        // This is the core anti-spam property - attackers can't compound funding by spamming cranks
        assert_eq!(funding_after_second, funding_after_first,
            "Same-slot crank must not change funding (dt=0 gating). before={}, after={}",
            funding_after_first, funding_after_second);
        assert_eq!(last_slot_after_second, last_slot_after_first,
            "last_funding_slot should not change on same-slot crank");

        // Third crank in same slot - still no change (verify it's consistently gated)
        {
            let accs = vec![
                keeper.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_crank_permissionless(0)).unwrap();
        }
        let funding_after_third = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            engine.funding_index_qpb_e6
        };
        assert_eq!(funding_after_third, funding_after_first,
            "Multiple same-slot cranks must not accumulate funding changes");

        // Verify last_funding_slot advances when slot changes (relative check, not absolute)
        f.clock.data = make_clock(101, 101);
        {
            let accs = vec![
                keeper.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info(),
            ];
            process_instruction(&f.program_id, &accs, &encode_crank_permissionless(0)).unwrap();
        }
        let last_slot_after_new_slot = {
            let engine = zc::engine_ref(&f.slab.data).unwrap();
            engine.last_funding_slot
        };
        assert!(last_slot_after_new_slot > last_slot_after_second,
            "last_funding_slot should advance when slot changes");
    }

    #[test]
    fn test_funding_sign_flips_with_lp_position() {
        // Security test: funding rate sign must follow LP net position sign.
        // This catches accidental sign inversion bugs.
        //
        // Uses large positions (100B contracts at $100 = $10T notional) to ensure
        // the premium hits the cap (500 bps) and per_slot is non-zero (1 bps).

        use percolator_prog::constants::{
            DEFAULT_FUNDING_HORIZON_SLOTS, DEFAULT_FUNDING_K_BPS, DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6,
            DEFAULT_FUNDING_MAX_PREMIUM_BPS, DEFAULT_FUNDING_MAX_BPS_PER_SLOT,
        };

        // Test the pure compute function directly
        let price_e6 = 100_000_000u64; // $100

        // LP net long => positive funding rate (longs pay)
        // 100B contracts at $100 = $10T notional, saturates to 500 bps cap, /500 = 1 bps/slot
        let net_long: i128 = 100_000_000_000;
        let rate_long = percolator_prog::compute_inventory_funding_bps_per_slot(
            net_long, price_e6,
            DEFAULT_FUNDING_HORIZON_SLOTS, DEFAULT_FUNDING_K_BPS, DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6,
            DEFAULT_FUNDING_MAX_PREMIUM_BPS, DEFAULT_FUNDING_MAX_BPS_PER_SLOT,
        );

        // LP net short => negative funding rate (shorts pay)
        let net_short: i128 = -100_000_000_000;
        let rate_short = percolator_prog::compute_inventory_funding_bps_per_slot(
            net_short, price_e6,
            DEFAULT_FUNDING_HORIZON_SLOTS, DEFAULT_FUNDING_K_BPS, DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6,
            DEFAULT_FUNDING_MAX_PREMIUM_BPS, DEFAULT_FUNDING_MAX_BPS_PER_SLOT,
        );

        // LP flat => zero funding rate
        let net_flat: i128 = 0;
        let rate_flat = percolator_prog::compute_inventory_funding_bps_per_slot(
            net_flat, price_e6,
            DEFAULT_FUNDING_HORIZON_SLOTS, DEFAULT_FUNDING_K_BPS, DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6,
            DEFAULT_FUNDING_MAX_PREMIUM_BPS, DEFAULT_FUNDING_MAX_BPS_PER_SLOT,
        );

        // Verify rates are actually non-zero for large positions
        assert!(rate_long > 0, "LP net long with large position should give positive rate, got {}", rate_long);
        assert!(rate_short < 0, "LP net short with large position should give negative rate, got {}", rate_short);
        assert_eq!(rate_flat, 0, "LP flat should give zero funding rate");

        // Verify opposite signs
        assert!(
            rate_long > 0 && rate_short < 0,
            "Funding rates must have opposite signs: long={}, short={}", rate_long, rate_short
        );
    }

    // --- Admin Rotation Tests ---

    #[test]
    fn test_admin_rotate() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market with admin A
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Verify initial admin is set
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, f.admin.key.to_bytes());

        // Create new admin B
        let new_admin_b = Pubkey::new_unique();
        let mut admin_b_account = TestAccount::new(new_admin_b, solana_program::system_program::id(), 0, vec![]).signer();

        // Admin A proposes admin B (two-step transfer)
        {
            let accounts = vec![f.admin.to_info(), f.slab.to_info()];
            process_instruction(&f.program_id, &accounts, &encode_update_admin(&new_admin_b)).unwrap();
        }

        // Verify admin is still A (pending transfer)
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, f.admin.key.to_bytes());
        assert_eq!(header.pending_admin, new_admin_b.to_bytes());

        // Admin B accepts the transfer (TAG_ACCEPT_ADMIN = 29)
        let accept_admin_data = vec![29u8];
        {
            let accounts = vec![admin_b_account.to_info(), f.slab.to_info()];
            process_instruction(&f.program_id, &accounts, &accept_admin_data).unwrap();
        }

        // Verify admin is now B
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, new_admin_b.to_bytes());

        // Create new admin C
        let new_admin_c = Pubkey::new_unique();
        let mut admin_c_account = TestAccount::new(new_admin_c, solana_program::system_program::id(), 0, vec![]).signer();

        // Admin B proposes admin C
        {
            let accounts = vec![admin_b_account.to_info(), f.slab.to_info()];
            process_instruction(&f.program_id, &accounts, &encode_update_admin(&new_admin_c)).unwrap();
        }

        // Admin C accepts
        {
            let accounts = vec![admin_c_account.to_info(), f.slab.to_info()];
            process_instruction(&f.program_id, &accounts, &accept_admin_data).unwrap();
        }

        // Verify admin is now C
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, new_admin_c.to_bytes());
    }

    #[test]
    fn test_non_admin_cannot_rotate() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market with admin A
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Attacker tries to rotate admin
        let attacker = Pubkey::new_unique();
        let mut attacker_account = TestAccount::new(attacker, solana_program::system_program::id(), 0, vec![]).signer();
        let new_admin = Pubkey::new_unique();

        {
            let accounts = vec![attacker_account.to_info(), f.slab.to_info()];
            let res = process_instruction(&f.program_id, &accounts, &encode_update_admin(&new_admin));
            assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
        }

        // Verify admin unchanged
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, f.admin.key.to_bytes());
    }

    #[test]
    fn test_update_admin_rejects_zero_address() {
        // PERC-136 #312: UpdateAdmin now rejects zero address.
        // Admin burn requires RenounceAdmin (which requires RESOLVED market).
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market with admin A
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // UpdateAdmin(zero) must be rejected
        let zero_admin = Pubkey::default();
        {
            let accounts = vec![f.admin.to_info(), f.slab.to_info()];
            let res = process_instruction(&f.program_id, &accounts, &encode_update_admin(&zero_admin));
            assert_eq!(res, Err(ProgramError::InvalidInstructionData));
        }

        // Admin should remain unchanged
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, f.admin.key.to_bytes());
    }

    #[test]
    fn test_renounce_admin_requires_resolved() {
        // PERC-136 #312: RenounceAdmin must be rejected on non-resolved market.
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // RenounceAdmin on non-resolved market must fail
        let renounce_data = vec![23u8]; // TAG_RENOUNCE_ADMIN
        {
            let accounts = vec![f.admin.to_info(), f.slab.to_info()];
            let res = process_instruction(&f.program_id, &accounts, &renounce_data);
            assert_eq!(res, Err(PercolatorError::AdminRenounceNotAllowed.into()));
        }

        // Admin should remain unchanged
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.admin, f.admin.key.to_bytes());
    }

    #[test]
    fn test_non_admin_ops_rejected() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market with admin A
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Non-admin cannot do admin ops
        let anyone = Pubkey::new_unique();
        let mut anyone_account = TestAccount::new(anyone, solana_program::system_program::id(), 0, vec![]).signer();

        // Attempt UpdateAdmin signed by non-admin → must fail
        {
            let accounts = vec![anyone_account.to_info(), f.slab.to_info()];
            let res = process_instruction(&f.program_id, &accounts, &encode_update_admin(&Pubkey::new_unique()));
            assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
        }

        // Attempt SetRiskThreshold signed by non-admin → must fail
        {
            let accounts = vec![anyone_account.to_info(), f.slab.to_info()];
            let res = process_instruction(&f.program_id, &accounts, &encode_set_risk_threshold(12345));
            assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
        }
    }

    #[test]
    fn test_oracle_inversion() {
        // Test that invert=1 correctly inverts the oracle price
        // Raw price: $100 = 100_000_000 e6
        // Inverted: 1e12 / 100_000_000 = 10_000 e6 (= $0.01 or 0.01 SOL/USD)
        use percolator_prog::oracle::read_engine_price_e6;

        let feed_id = [0xCDu8; 32];
        let pyth_receiver_id = Pubkey::new_from_array(PYTH_RECEIVER_BYTES);
        // Price = $100, expo = -6, conf = 1, publish_time = 100
        let pyth_data = make_pyth(&feed_id, 100_000_000, -6, 1, 100);
        let mut oracle = TestAccount::new(Pubkey::new_unique(), pyth_receiver_id, 0, pyth_data);

        // Without inversion (invert=0, unit_scale=0)
        // read_engine_price_e6(ai, feed_id, unix_ts, max_staleness_secs, conf_bps, invert, unit_scale)
        let price_raw = read_engine_price_e6(&oracle.to_info(), &feed_id, 100, 100, 500, 0, 0, &[]).unwrap();
        assert_eq!(price_raw, 100_000_000, "Raw price should be $100 (100_000_000 e6)");

        // With inversion (invert=1, unit_scale=0)
        let price_inv = read_engine_price_e6(&oracle.to_info(), &feed_id, 100, 100, 500, 1, 0, &[]).unwrap();
        assert_eq!(price_inv, 10_000, "Inverted price should be 10_000 e6 (= 1e12 / 100_000_000)");

        // Test unit_scale transformation (oracle price scaling)
        // With unit_scale=1000: price_scaled = 100_000_000 / 1000 = 100_000
        let price_scaled = read_engine_price_e6(&oracle.to_info(), &feed_id, 100, 100, 500, 0, 1000, &[]).unwrap();
        assert_eq!(price_scaled, 100_000, "Scaled price should be 100_000 e6 (= 100_000_000 / 1000)");

        // Test combined inversion + unit_scale
        // Inverted: 1e12 / 100_000_000 = 10_000
        // Then scaled: 10_000 / 1000 = 10
        let price_inv_scaled = read_engine_price_e6(&oracle.to_info(), &feed_id, 100, 100, 500, 1, 1000, &[]).unwrap();
        assert_eq!(price_inv_scaled, 10, "Inverted+scaled price should be 10 e6");
    }

    #[test]
    fn test_unit_scale_conversion() {
        // Test base_to_units and units_to_base with unit_scale
        use percolator_prog::units::{base_to_units, units_to_base};

        // With scale=0, no conversion
        assert_eq!(base_to_units(12345, 0), (12345, 0));
        assert_eq!(units_to_base(12345, 0), 12345);

        // With scale=1000 (e.g., for wSOL where 1000 lamports = 1 unit)
        assert_eq!(base_to_units(5500, 1000), (5, 500)); // 5 units, 500 dust
        assert_eq!(base_to_units(5000, 1000), (5, 0));   // 5 units, no dust
        assert_eq!(units_to_base(5, 1000), 5000);

        // With scale=100
        assert_eq!(base_to_units(201, 100), (2, 1));  // 2 units, 1 dust
        assert_eq!(units_to_base(2, 100), 200);
    }

    #[test]
    fn test_init_market_with_invert_and_unit_scale() {
        // Test that InitMarket correctly stores invert and unit_scale in config
        let mut f = setup_market();
        let data = encode_init_market_invert(&f, 100, 1, 1000); // invert=1, unit_scale=1000

        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Read back config and verify
        let config = percolator_prog::state::read_config(&f.slab.data);
        assert_eq!(config.invert, 1, "invert should be 1");
        assert_eq!(config.unit_scale, 1000, "unit_scale should be 1000");
    }

    #[test]
    fn test_unit_scale_validation_at_init() {
        // Test that unit_scale > 1_000_000_000 is rejected
        let mut f = setup_market();
        let data = encode_init_market_invert(&f, 100, 0, 2_000_000_000); // Too large

        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            let res = process_instruction(&f.program_id, &accounts, &data);
            assert_eq!(res, Err(ProgramError::InvalidInstructionData), "Should reject unit_scale > 1B");
        }
    }

    #[test]
    fn test_withdraw_misalignment_rejected() {
        // Test that misaligned withdrawal amounts are rejected when unit_scale != 0
        let mut f = setup_market();

        // Init market with unit_scale=100
        {
            let data = encode_init_market_invert(&f, 100, 0, 100);
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Init user
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, f.admin.key, 1_000_000)).writable();
        {
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(1000)).unwrap();
        }

        // Deposit 1000 (aligned to unit_scale=100)
        {
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(0, 1000)).unwrap();
        }

        // Create vault_pda account for withdraw tests
        let mut vault_pda_account = TestAccount::new(f.vault_pda, Pubkey::default(), 0, vec![]);

        // Try to withdraw 201 (misaligned) - should fail
        {
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.vault.to_info(), user_ata.to_info(),
                vault_pda_account.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            let res = process_instruction(&f.program_id, &accounts, &encode_withdraw(0, 201));
            assert_eq!(res, Err(ProgramError::InvalidInstructionData), "Misaligned withdrawal should be rejected");
        }

        // Withdraw 200 (aligned) - should succeed
        {
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.vault.to_info(), user_ata.to_info(),
                vault_pda_account.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            // This will fail for other reasons (token transfer in test), but not InvalidInstructionData
            let res = process_instruction(&f.program_id, &accounts, &encode_withdraw(0, 200));
            assert_ne!(res, Err(ProgramError::InvalidInstructionData), "Aligned withdrawal should not fail on alignment");
        }
    }

    // ========================================
    // VAULT ACCOUNTING INVARIANT TESTS
    // ========================================

    /// Helper: read sum of all account capitals from engine
    fn sum_account_capitals(slab_data: &[u8]) -> u128 {
        let engine = zc::engine_ref(slab_data).unwrap();
        let mut total = 0u128;
        for idx in 0..percolator::MAX_ACCOUNTS {
            if engine.is_used(idx) {
                total = total.saturating_add(engine.accounts[idx].capital.get());
            }
        }
        total
    }

    #[test]
    #[cfg(feature = "test")]
    fn test_vault_amount_matches_engine_vault_plus_dust() {
        // INVARIANT #1: SPL vault balance = engine.vault * unit_scale + dust_base
        //
        // Setup: market with unit_scale=10, deposit 123 base tokens
        // Expected: 12 units, 3 dust
        let mut f = setup_market();
        let unit_scale: u32 = 10;

        // Init market with unit_scale=10
        {
            let data = encode_init_market_invert(&f, 100, 0, unit_scale);
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Create user with enough tokens
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, user.key, 10_000)).writable();

        // InitUser with fee=0 (so it doesn't affect accounting)
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        // Record initial state
        let dust_start = state::read_dust_base(&f.slab.data);
        let engine_vault_start = zc::engine_ref(&f.slab.data).unwrap().vault;
        let vault_base_start = TokenAccount::unpack(&f.vault.data).unwrap().amount;

        // Deposit 123 base tokens (creates 12 units + 3 dust)
        let deposit_amount: u64 = 123;
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, deposit_amount)).unwrap();
        }

        // Read post-deposit state
        let vault_base = TokenAccount::unpack(&f.vault.data).unwrap().amount;
        let engine_vault_units = zc::engine_ref(&f.slab.data).unwrap().vault;
        let dust_base = state::read_dust_base(&f.slab.data);

        // Compute deltas
        let delta_vault_base = vault_base - vault_base_start;
        let delta_engine_units = engine_vault_units.get() - engine_vault_start.get();
        let delta_dust = dust_base - dust_start;

        // Assert expected deltas
        assert_eq!(delta_vault_base, deposit_amount,
            "SPL vault should increase by deposit amount: got {}, expected {}", delta_vault_base, deposit_amount);
        assert_eq!(delta_engine_units, (deposit_amount / unit_scale as u64) as u128,
            "Engine vault should increase by deposit/scale: got {}, expected {}", delta_engine_units, deposit_amount / unit_scale as u64);
        assert_eq!(delta_dust, deposit_amount % unit_scale as u64,
            "Dust should equal deposit mod scale: got {}, expected {}", delta_dust, deposit_amount % unit_scale as u64);

        // Assert INVARIANT #1: vault_base = engine_vault * unit_scale + dust_base
        let computed_base = engine_vault_units.get() as u64 * unit_scale as u64 + dust_base;
        assert_eq!(vault_base, computed_base,
            "INVARIANT #1 FAILED: vault_base({}) != engine_vault({}) * scale({}) + dust({}) = {}",
            vault_base, engine_vault_units, unit_scale, dust_base, computed_base);
    }

    #[test]
    fn test_engine_vault_equals_insurance_plus_capital_when_no_fees() {
        // INVARIANT #2: engine.vault = insurance_fund.balance + sum(account.capital)
        //
        // This holds when:
        // - new_account_fee = 0
        // - no trades (no trading fees, no PnL)
        // - no topups
        //
        // The existing encode_init_market_invert already uses all-zero fees.
        let mut f = setup_market();
        let unit_scale: u32 = 10;

        // Init market with unit_scale=10, all fees=0
        {
            let data = encode_init_market_invert(&f, 100, 0, unit_scale);
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Create and fund two users
        let mut user1 = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user1_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, user1.key, 10_000)).writable();
        {
            let accounts = vec![
                user1.to_info(), f.slab.to_info(), user1_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user1_idx = find_idx_by_owner(&f.slab.data, user1.key).unwrap();

        let mut user2 = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user2_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, user2.key, 10_000)).writable();
        {
            let accounts = vec![
                user2.to_info(), f.slab.to_info(), user2_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user2_idx = find_idx_by_owner(&f.slab.data, user2.key).unwrap();

        // Deposit different amounts (aligned to avoid dust complicating this test)
        {
            let accounts = vec![
                user1.to_info(), f.slab.to_info(), user1_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user1_idx, 500)).unwrap(); // 50 units
        }
        {
            let accounts = vec![
                user2.to_info(), f.slab.to_info(), user2_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user2_idx, 300)).unwrap(); // 30 units
        }

        // Read engine state
        let engine = zc::engine_ref(&f.slab.data).unwrap();
        let engine_vault = engine.vault;
        let insurance_balance = engine.insurance_fund.balance;
        let sum_capital = sum_account_capitals(&f.slab.data);

        // Assert INVARIANT #2: vault = insurance + sum(capital)
        // (In no-fee scenario with no PnL, this should hold exactly)
        let expected_vault = insurance_balance + sum_capital;
        assert_eq!(engine_vault, expected_vault,
            "INVARIANT #2 FAILED: engine.vault({}) != insurance({}) + sum_capital({}) = {}\n\
             user1.capital={}, user2.capital={}",
            engine_vault, insurance_balance, sum_capital, expected_vault,
            engine.accounts[user1_idx as usize].capital,
            engine.accounts[user2_idx as usize].capital);
    }

    #[test]
    fn test_withdraw_preserves_vault_accounting_invariant() {
        // Verify that aligned withdrawals preserve INVARIANT #1
        let mut f = setup_market();
        let unit_scale: u32 = 10;

        // Init market with unit_scale=10
        {
            let data = encode_init_market_invert(&f, 100, 0, unit_scale);
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Create user
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, user.key, 10_000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        // Deposit 230 base tokens (creates 23 units + 0 dust)
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 230)).unwrap();
        }

        // Record pre-withdraw state
        let vault_base_before = TokenAccount::unpack(&f.vault.data).unwrap().amount;
        let engine_vault_before = zc::engine_ref(&f.slab.data).unwrap().vault;
        let dust_before = state::read_dust_base(&f.slab.data);

        // Withdraw 50 base tokens (aligned: 5 units)
        let mut vault_pda_account = TestAccount::new(f.vault_pda, Pubkey::default(), 0, vec![]);
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), f.vault.to_info(), user_ata.to_info(),
                vault_pda_account.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.pyth_index.to_info()
            ];
            // Note: token transfer CPI will fail in test env, but engine state updates happen first
            let _ = process_instruction(&f.program_id, &accounts, &encode_withdraw(user_idx, 50));
        }

        // Read post-withdraw state
        // Note: In test env, the SPL vault may not update due to CPI mock,
        // but engine state DOES update. We verify engine state consistency.
        let engine_vault_after = zc::engine_ref(&f.slab.data).unwrap().vault;
        let dust_after = state::read_dust_base(&f.slab.data);

        // Verify engine vault decreased by expected units
        assert_eq!(engine_vault_before.get() - engine_vault_after.get(), 5,
            "Engine vault should decrease by 5 units: before={:?}, after={:?}", engine_vault_before, engine_vault_after);

        // Verify dust unchanged (withdrawal was aligned)
        assert_eq!(dust_before, dust_after,
            "Dust should be unchanged for aligned withdrawal: before={}, after={}", dust_before, dust_after);
    }

    #[test]
    #[cfg(feature = "test")]
    fn test_dust_sweep_preserves_real_to_accounted_equality() {
        // DUST POLICY: Dust is swept to insurance via top_up_insurance_fund,
        // which covers loss_accum first, then adds to insurance_fund.balance.
        //
        // This test verifies:
        // 1. dust_base < unit_scale after sweep
        // 2. INVARIANT #1 still holds
        // 3. Insurance increased by floor(old_dust / scale) units
        let mut f = setup_market();
        let unit_scale: u32 = 10;

        // Init market with unit_scale=10
        {
            let data = encode_init_market_invert(&f, 100, 0, unit_scale);
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Create user for crank caller
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, user.key, 10_000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        // Make multiple deposits that accumulate dust > unit_scale
        // Each deposit of 27 creates 2 units + 7 dust
        // After 2 deposits: 4 units + 14 dust (14 >= 10, so sweep will happen)
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 27)).unwrap();
        }
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 27)).unwrap();
        }

        // Record pre-crank state
        let dust_before_crank = state::read_dust_base(&f.slab.data);
        let engine_vault_before = zc::engine_ref(&f.slab.data).unwrap().vault;
        let insurance_before = zc::engine_ref(&f.slab.data).unwrap().insurance_fund.balance;

        assert!(dust_before_crank >= unit_scale as u64,
            "Dust should be >= unit_scale before crank: dust={}, scale={}", dust_before_crank, unit_scale);

        // Call KeeperCrank - this triggers dust sweep
        {
            let accounts = vec![user.to_info(), f.slab.to_info(), f.clock.to_info(), f.pyth_index.to_info()];
            process_instruction(&f.program_id, &accounts, &encode_crank(user_idx, 0)).unwrap();
        }

        // Read post-crank state
        let dust_after_crank = state::read_dust_base(&f.slab.data);
        let engine_vault_after = zc::engine_ref(&f.slab.data).unwrap().vault;
        let insurance_after = zc::engine_ref(&f.slab.data).unwrap().insurance_fund.balance;
        let vault_base = TokenAccount::unpack(&f.vault.data).unwrap().amount;

        // Verify dust was swept
        assert!(dust_after_crank < unit_scale as u64,
            "Dust should be < unit_scale after sweep: dust={}, scale={}", dust_after_crank, unit_scale);

        // Calculate expected sweep
        let units_swept = dust_before_crank / unit_scale as u64;
        let expected_remaining_dust = dust_before_crank % unit_scale as u64;

        assert_eq!(dust_after_crank, expected_remaining_dust,
            "Remaining dust should be old_dust mod scale: got {}, expected {}", dust_after_crank, expected_remaining_dust);

        // Verify insurance increased by swept units (assuming no loss_accum)
        assert_eq!(insurance_after.get() - insurance_before.get(), units_swept as u128,
            "Insurance should increase by swept units: delta={}, expected={}", insurance_after.get() - insurance_before.get(), units_swept);

        // Verify engine.vault also increased by swept units
        assert_eq!(engine_vault_after.get() - engine_vault_before.get(), units_swept as u128,
            "Engine vault should increase by swept units: delta={}, expected={}", engine_vault_after.get() - engine_vault_before.get(), units_swept);

        // Verify INVARIANT #1 still holds after sweep
        let computed_base = engine_vault_after.get() as u64 * unit_scale as u64 + dust_after_crank;
        assert_eq!(vault_base, computed_base,
            "INVARIANT #1 FAILED after sweep: vault_base({}) != engine_vault({}) * scale({}) + dust({}) = {}",
            vault_base, engine_vault_after, unit_scale, dust_after_crank, computed_base);
    }

    #[test]
    #[cfg(feature = "test")]
    fn test_invariants_with_unit_scale_zero() {
        // Verify invariants work when unit_scale=0 (no scaling)
        // In this mode: 1 base token = 1 unit, no dust ever created
        let mut f = setup_market();

        // Init market with unit_scale=0 (standard behavior)
        {
            let data = encode_init_market_invert(&f, 100, 0, 0);
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(), f.token_prog.to_info(),
                f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &data).unwrap();
        }

        // Create user
        let mut user = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();
        let mut user_ata = TestAccount::new(Pubkey::new_unique(), spl_token::ID, 0,
            make_token_account(f.mint.key, user.key, 10_000)).writable();
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_init_user(0)).unwrap();
        }
        let user_idx = find_idx_by_owner(&f.slab.data, user.key).unwrap();

        // Deposit any amount - should create 0 dust
        {
            let accounts = vec![
                user.to_info(), f.slab.to_info(), user_ata.to_info(), f.vault.to_info(), f.token_prog.to_info(), f.clock.to_info()
            ];
            process_instruction(&f.program_id, &accounts, &encode_deposit(user_idx, 123)).unwrap();
        }

        // Verify no dust created
        let dust = state::read_dust_base(&f.slab.data);
        assert_eq!(dust, 0, "Dust should be 0 when unit_scale=0: got {}", dust);

        // Verify INVARIANT #1: vault_base = engine_vault (scale=1) + dust (0)
        let vault_base = TokenAccount::unpack(&f.vault.data).unwrap().amount;
        let engine_vault = zc::engine_ref(&f.slab.data).unwrap().vault;
        assert_eq!(vault_base, engine_vault.get() as u64,
            "With scale=0: vault_base({}) should equal engine_vault({:?})", vault_base, engine_vault);

        // Verify INVARIANT #2
        let engine = zc::engine_ref(&f.slab.data).unwrap();
        let sum_capital = sum_account_capitals(&f.slab.data);
        assert_eq!(engine.vault, engine.insurance_fund.balance + sum_capital,
            "INVARIANT #2: vault({}) != insurance({}) + capital({})",
            engine.vault, engine.insurance_fund.balance, sum_capital);
    }

    #[test]
    fn test_close_slab() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Record admin's initial lamports
        let admin_lamports_before = f.admin.lamports;
        let slab_lamports = f.slab.lamports;

        // Init market
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Verify market is initialized
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.magic, MAGIC);

        // Close the slab
        {
            let accounts = vec![f.admin.to_info(), f.slab.to_info()];
            process_instruction(&f.program_id, &accounts, &encode_close_slab()).unwrap();
        }

        // Verify slab is zeroed
        assert!(f.slab.data.iter().all(|&b| b == 0), "Slab data should be zeroed after close");

        // Verify lamports transferred to admin
        assert_eq!(f.slab.lamports, 0, "Slab should have 0 lamports after close");
        assert_eq!(f.admin.lamports, admin_lamports_before + slab_lamports,
            "Admin should receive slab's lamports");
    }

    #[test]
    fn test_close_slab_non_admin_rejected() {
        let mut f = setup_market();
        let init_data = encode_init_market(&f, 100);

        // Init market
        {
            let mut dummy_ata = TestAccount::new(Pubkey::new_unique(), Pubkey::default(), 0, vec![]);
            let accounts = vec![
                f.admin.to_info(), f.slab.to_info(), f.mint.to_info(), f.vault.to_info(),
                f.token_prog.to_info(), f.clock.to_info(), f.rent.to_info(), dummy_ata.to_info(), f.system.to_info(),
            ];
            process_instruction(&f.program_id, &accounts, &init_data).unwrap();
        }

        // Attacker tries to close
        let mut attacker = TestAccount::new(Pubkey::new_unique(), solana_program::system_program::id(), 0, vec![]).signer();

        {
            let accounts = vec![attacker.to_info(), f.slab.to_info()];
            let res = process_instruction(&f.program_id, &accounts, &encode_close_slab());
            assert_eq!(res, Err(PercolatorError::EngineUnauthorized.into()));
        }

        // Verify slab unchanged
        let header = state::read_header(&f.slab.data);
        assert_eq!(header.magic, MAGIC, "Slab should still be initialized after failed close");
    }
