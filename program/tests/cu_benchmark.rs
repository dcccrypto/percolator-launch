//! BPF Compute Unit benchmark using LiteSVM
//!
//! Tests worst-case CU scenarios for keeper crank:
//! 1. All empty slots - baseline scan overhead
//! 2. All dust accounts - minimal balances, no positions
//! 3. Few liquidations - some accounts underwater
//! 4. All deeply underwater - socialized losses
//! 5. 4096 knife-edge liquidations - worst case
//!
//! Build BPF: cargo build-sbf (production) or cargo build-sbf --features test (small)
//! Run: cargo test --release --test cu_benchmark -- --nocapture

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    sysvar,
    transaction::Transaction,
    program_pack::Pack,
};
use spl_token::state::{Account as TokenAccount, AccountState};
use std::path::PathBuf;
// Note: Can't read BPF slab from native - struct layouts differ:
// BPF SLAB_LEN: ~1.1MB, Native SLAB_LEN: ~1.2MB (even with repr(C) and same MAX_ACCOUNTS)

// SLAB_LEN for SBF - differs between test and production
#[cfg(feature = "test")]
const SLAB_LEN: usize = 16312;  // MAX_ACCOUNTS=64 - haircut-ratio engine + oracle circuit breaker (no padding)

#[cfg(not(feature = "test"))]
const SLAB_LEN: usize = 992560;  // MAX_ACCOUNTS=4096 - haircut-ratio engine + oracle circuit breaker (no padding)

#[cfg(feature = "test")]
const MAX_ACCOUNTS: usize = 64;

#[cfg(not(feature = "test"))]
const MAX_ACCOUNTS: usize = 4096;

// Pyth Receiver program ID (rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ)
const PYTH_RECEIVER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x0c, 0xb7, 0xfa, 0xbb, 0x52, 0xf7, 0xa6, 0x48,
    0xbb, 0x5b, 0x31, 0x7d, 0x9a, 0x01, 0x8b, 0x90,
    0x57, 0xcb, 0x02, 0x47, 0x74, 0xfa, 0xfe, 0x01,
    0xe6, 0xc4, 0xdf, 0x98, 0xcc, 0x38, 0x58, 0x81,
]);

/// Default feed_id for CU benchmarks
const BENCHMARK_FEED_ID: [u8; 32] = [0xABu8; 32];

fn program_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("target/deploy/percolator_prog.so");
    path
}

fn make_token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; TokenAccount::LEN];
    let mut account = TokenAccount::default();
    account.mint = *mint;
    account.owner = *owner;
    account.amount = amount;
    account.state = AccountState::Initialized;
    TokenAccount::pack(account, &mut data).unwrap();
    data
}

fn make_mint_data() -> Vec<u8> {
    use spl_token::state::Mint;
    let mut data = vec![0u8; Mint::LEN];
    let mint = Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: solana_sdk::program_option::COption::None,
    };
    Mint::pack(mint, &mut data).unwrap();
    data
}

/// Create PriceUpdateV2 mock data (Pyth Pull format)
/// Layout: discriminator(8) + write_authority(32) + verification_level(2) + feed_id(32) +
///         price(8) + conf(8) + expo(4) + publish_time(8) + ...
fn make_pyth_data(feed_id: &[u8; 32], price: i64, expo: i32, conf: u64, publish_time: i64) -> Vec<u8> {
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

// Instruction encoders
fn encode_init_market_with_params(
    admin: &Pubkey,
    mint: &Pubkey,
    feed_id: &[u8; 32],
    risk_reduction_threshold: u128,
    warmup_period_slots: u64,
) -> Vec<u8> {
    let mut data = vec![0u8];
    data.extend_from_slice(admin.as_ref());
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(feed_id);
    data.extend_from_slice(&u64::MAX.to_le_bytes()); // max_staleness_secs
    data.extend_from_slice(&500u16.to_le_bytes()); // conf_filter_bps
    data.push(0u8); // invert (0 = no inversion)
    data.extend_from_slice(&0u32.to_le_bytes()); // unit_scale (0 = no scaling)
    // RiskParams
    data.extend_from_slice(&warmup_period_slots.to_le_bytes());
    data.extend_from_slice(&500u64.to_le_bytes()); // maintenance_margin_bps (5%)
    data.extend_from_slice(&1000u64.to_le_bytes()); // initial_margin_bps (10%)
    data.extend_from_slice(&0u64.to_le_bytes());   // trading_fee_bps
    data.extend_from_slice(&(MAX_ACCOUNTS as u64).to_le_bytes());
    data.extend_from_slice(&0u128.to_le_bytes());  // new_account_fee
    data.extend_from_slice(&risk_reduction_threshold.to_le_bytes());
    data.extend_from_slice(&0u128.to_le_bytes());  // maintenance_fee_per_slot
    data.extend_from_slice(&u64::MAX.to_le_bytes()); // max_crank_staleness_slots
    data.extend_from_slice(&50u64.to_le_bytes());  // liquidation_fee_bps
    data.extend_from_slice(&1_000_000_000_000u128.to_le_bytes()); // liquidation_fee_cap
    data.extend_from_slice(&100u64.to_le_bytes()); // liquidation_buffer_bps
    data.extend_from_slice(&0u128.to_le_bytes());  // min_liquidation_abs
    data
}

fn encode_init_market(admin: &Pubkey, mint: &Pubkey, feed_id: &[u8; 32]) -> Vec<u8> {
    encode_init_market_with_params(admin, mint, feed_id, 0, 0)
}

fn encode_init_user(fee: u64) -> Vec<u8> {
    let mut data = vec![1u8];
    data.extend_from_slice(&fee.to_le_bytes());
    data
}

fn encode_init_lp(matcher: &Pubkey, ctx: &Pubkey, fee: u64) -> Vec<u8> {
    let mut data = vec![2u8];
    data.extend_from_slice(matcher.as_ref());
    data.extend_from_slice(ctx.as_ref());
    data.extend_from_slice(&fee.to_le_bytes());
    data
}

fn encode_deposit(user_idx: u16, amount: u64) -> Vec<u8> {
    let mut data = vec![3u8];
    data.extend_from_slice(&user_idx.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

fn encode_crank_permissionless(panic: u8) -> Vec<u8> {
    let mut data = vec![5u8];
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.push(panic);
    data
}

fn encode_trade(lp: u16, user: u16, size: i128) -> Vec<u8> {
    let mut data = vec![6u8];
    data.extend_from_slice(&lp.to_le_bytes());
    data.extend_from_slice(&user.to_le_bytes());
    data.extend_from_slice(&size.to_le_bytes());
    data
}

struct TestEnv {
    svm: LiteSVM,
    program_id: Pubkey,
    payer: Keypair,
    slab: Pubkey,
    mint: Pubkey,
    vault: Pubkey,
    pyth_index: Pubkey,
    pyth_col: Pubkey,
}

impl TestEnv {
    fn new() -> Self {
        let path = program_path();
        if !path.exists() {
            panic!("BPF not found at {:?}. Run: cargo build-sbf", path);
        }

        let mut svm = LiteSVM::new();
        let program_id = Pubkey::new_unique();
        let program_bytes = std::fs::read(&path).expect("Failed to read program");
        svm.add_program(program_id, &program_bytes);

        let payer = Keypair::new();
        let slab = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let pyth_index = Pubkey::new_unique();
        let pyth_col = Pubkey::new_unique();
        let (vault_pda, _) = Pubkey::find_program_address(&[b"vault", slab.as_ref()], &program_id);
        let vault = Pubkey::new_unique();

        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

        svm.set_account(slab, Account {
            lamports: 1_000_000_000,
            data: vec![0u8; SLAB_LEN],
            owner: program_id,
            executable: false,
            rent_epoch: 0,
        }).unwrap();

        svm.set_account(mint, Account {
            lamports: 1_000_000,
            data: make_mint_data(),
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();

        svm.set_account(vault, Account {
            lamports: 1_000_000,
            data: make_token_account_data(&mint, &vault_pda, 0),
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();

        let pyth_data = make_pyth_data(&BENCHMARK_FEED_ID, 100_000_000, -6, 1, 100); // $100
        svm.set_account(pyth_index, Account {
            lamports: 1_000_000,
            data: pyth_data.clone(),
            owner: PYTH_RECEIVER_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();
        svm.set_account(pyth_col, Account {
            lamports: 1_000_000,
            data: pyth_data,
            owner: PYTH_RECEIVER_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();

        svm.set_sysvar(&Clock { slot: 100, unix_timestamp: 100, ..Clock::default() });

        TestEnv { svm, program_id, payer, slab, mint, vault, pyth_index, pyth_col }
    }

    fn init_market(&mut self) {
        self.init_market_with_params(0, 0);
    }

    fn init_market_with_params(&mut self, risk_reduction_threshold: u128, warmup_period_slots: u64) {
        let admin = &self.payer;
        let dummy_ata = Pubkey::new_unique();
        self.svm.set_account(dummy_ata, Account {
            lamports: 1_000_000,
            data: vec![0u8; TokenAccount::LEN],
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();

        // InitMarket now expects 9 accounts (removed pyth_index and pyth_col)
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
                AccountMeta::new_readonly(sysvar::rent::ID, false),
                AccountMeta::new_readonly(dummy_ata, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: encode_init_market_with_params(
                &admin.pubkey(),
                &self.mint,
                &BENCHMARK_FEED_ID,
                risk_reduction_threshold,
                warmup_period_slots,
            ),
        };

        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&admin.pubkey()), &[admin], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("init_market failed");
    }

    fn create_ata(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let ata = Pubkey::new_unique();
        self.svm.set_account(ata, Account {
            lamports: 1_000_000,
            data: make_token_account_data(&self.mint, owner, amount),
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();
        ata
    }

    fn init_lp(&mut self, owner: &Keypair) -> u16 {
        self.svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
        let ata = self.create_ata(&owner.pubkey(), 0);
        let matcher = spl_token::ID;
        let ctx = Pubkey::new_unique();
        self.svm.set_account(ctx, Account {
            lamports: 1_000_000,
            data: vec![0u8; 320],
            owner: matcher,
            executable: false,
            rent_epoch: 0,
        }).unwrap();

        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new(ata, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(matcher, false),
                AccountMeta::new_readonly(ctx, false),
            ],
            data: encode_init_lp(&matcher, &ctx, 0),
        };

        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&owner.pubkey()), &[owner], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("init_lp failed");
        0
    }

    fn init_user(&mut self, owner: &Keypair) -> u16 {
        self.svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
        let ata = self.create_ata(&owner.pubkey(), 0);

        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new(ata, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
                AccountMeta::new_readonly(self.pyth_col, false),
            ],
            data: encode_init_user(0),
        };

        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&owner.pubkey()), &[owner], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("init_user failed");
        1 // LP is 0
    }

    fn deposit(&mut self, owner: &Keypair, user_idx: u16, amount: u64) {
        let ata = self.create_ata(&owner.pubkey(), amount);

        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new(ata, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
            ],
            data: encode_deposit(user_idx, amount),
        };

        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&owner.pubkey()), &[owner], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("deposit failed");
    }

    fn trade(&mut self, user: &Keypair, lp: &Keypair, lp_idx: u16, user_idx: u16, size: i128) {
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(lp.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
                AccountMeta::new_readonly(self.pyth_index, false),
            ],
            data: encode_trade(lp_idx, user_idx, size),
        };

        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&user.pubkey()), &[user, lp], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("trade failed");
    }

    fn crank(&mut self) -> u64 {
        self.crank_with_cu_limit(1_400_000)
    }

    fn crank_with_cu_limit(&mut self, cu_limit: u32) -> u64 {
        let caller = Keypair::new();
        self.svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();

        let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(cu_limit);

        let crank_ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(caller.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
                AccountMeta::new_readonly(self.pyth_index, false),
            ],
            data: encode_crank_permissionless(0),
        };

        let tx = Transaction::new_signed_with_payer(
            &[budget_ix, crank_ix], Some(&caller.pubkey()), &[&caller], self.svm.latest_blockhash(),
        );
        let result = self.svm.send_transaction(tx).expect("crank failed");
        result.compute_units_consumed
    }

    fn set_price(&mut self, price_e6: i64, slot: u64) {
        // Set both slot and unix_timestamp (using slot value as unix_timestamp for simplicity)
        self.svm.set_sysvar(&Clock { slot, unix_timestamp: slot as i64, ..Clock::default() });
        let pyth_data = make_pyth_data(&BENCHMARK_FEED_ID, price_e6, -6, 1, slot as i64);

        self.svm.set_account(self.pyth_index, Account {
            lamports: 1_000_000,
            data: pyth_data.clone(),
            owner: PYTH_RECEIVER_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();
        self.svm.set_account(self.pyth_col, Account {
            lamports: 1_000_000,
            data: pyth_data,
            owner: PYTH_RECEIVER_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        }).unwrap();
    }

    fn try_crank(&mut self) -> Result<(u64, Vec<String>), String> {
        let caller = Keypair::new();
        self.svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();

        let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);

        let crank_ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(caller.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
                AccountMeta::new_readonly(self.pyth_index, false),
            ],
            data: encode_crank_permissionless(0),
        };

        let tx = Transaction::new_signed_with_payer(
            &[budget_ix, crank_ix], Some(&caller.pubkey()), &[&caller], self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(result) => Ok((result.compute_units_consumed, result.logs)),
            Err(e) => Err(format!("{:?}", e)),
        }
    }

    fn top_up_insurance(&mut self, funder: &Keypair, amount: u64) {
        let ata = self.create_ata(&funder.pubkey(), amount);

        // Instruction 9: TopUpInsurance { amount: u64 }
        let mut data = vec![9u8];
        data.extend_from_slice(&amount.to_le_bytes());

        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(funder.pubkey(), true),
                AccountMeta::new(self.slab, false),
                AccountMeta::new(ata, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
            ],
            data,
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&funder.pubkey()), &[funder], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("top_up_insurance failed");
    }
}

fn create_users(env: &mut TestEnv, count: usize, deposit_amount: u64) -> Vec<Keypair> {
    let mut users = Vec::with_capacity(count);
    for i in 0..count {
        let user = Keypair::new();
        env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
        let ata = env.create_ata(&user.pubkey(), 0);

        let ix = Instruction {
            program_id: env.program_id,
            accounts: vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(env.slab, false),
                AccountMeta::new(ata, false),
                AccountMeta::new(env.vault, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(sysvar::clock::ID, false),
                AccountMeta::new_readonly(env.pyth_col, false),
            ],
            data: encode_init_user(0),
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
        );
        env.svm.send_transaction(tx).unwrap();

        let user_idx = (i + 1) as u16;
        env.deposit(&user, user_idx, deposit_amount);
        users.push(user);

        if (i + 1) % 500 == 0 {
            println!("    Created {} users...", i + 1);
        }
    }
    users
}

#[cfg(not(feature = "test"))]
#[test]
fn benchmark_worst_case_scenarios() {
    println!("\n=== WORST-CASE CRANK CU BENCHMARK ===");
    println!("MAX_ACCOUNTS: {}", MAX_ACCOUNTS);
    println!("SLAB_LEN: {}", SLAB_LEN);
    println!("Solana max CU per tx: 1,400,000\n");

    // Assert we're testing with production config (4096 accounts)
    assert_eq!(MAX_ACCOUNTS, 4096, "Expected MAX_ACCOUNTS=4096 for production benchmark");
    assert!(SLAB_LEN > 900_000, "Expected SLAB_LEN > 900K for production benchmark, got {}", SLAB_LEN);

    let path = program_path();
    if !path.exists() {
        println!("SKIP: BPF not found. Run: cargo build-sbf");
        return;
    }

    // Scenario 1: All empty slots (just LP, no users)
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 1: 🟢 All empty slots (LP only) - LOWEST");
    {
        let mut env = TestEnv::new();
        env.init_market();

        let lp = Keypair::new();
        env.init_lp(&lp);
        env.deposit(&lp, 0, 1_000_000_000);

        env.set_price(100_000_000, 200);
        let cu = env.crank();
        println!("  CU: {:>10} (baseline scan overhead for {} slots)", cu, MAX_ACCOUNTS);
        let cu_per_slot = cu / MAX_ACCOUNTS as u64;
        println!("  CU/slot: ~{}", cu_per_slot);
    }

    // Scenario 2: All dust accounts (no positions)
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 2: 🟡 All dust accounts (no positions)");
    {
        let mut env = TestEnv::new();
        env.init_market();

        let lp = Keypair::new();
        env.init_lp(&lp);
        env.deposit(&lp, 0, 1_000_000_000_000);

        // Create users until we hit CU limit
        let mut users_created = 0;
        for i in 0..(MAX_ACCOUNTS - 1) {
            let user = Keypair::new();
            env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
            let ata = env.create_ata(&user.pubkey(), 0);

            let ix = Instruction {
                program_id: env.program_id,
                accounts: vec![
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new(env.slab, false),
                    AccountMeta::new(ata, false),
                    AccountMeta::new(env.vault, false),
                    AccountMeta::new_readonly(spl_token::ID, false),
                    AccountMeta::new_readonly(sysvar::clock::ID, false),
                    AccountMeta::new_readonly(env.pyth_col, false),
                ],
                data: encode_init_user(0),
            };
            let tx = Transaction::new_signed_with_payer(
                &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
            );
            env.svm.send_transaction(tx).unwrap();
            env.deposit(&user, (i + 1) as u16, 1);
            users_created = i + 1;

            if (i + 1) % 500 == 0 {
                println!("    Created {} users...", i + 1);
            }
        }
        println!("  Created {} dust users total", users_created);

        env.set_price(100_000_000, 200);
        match env.try_crank() {
            Ok((cu, _logs)) => {
                let cu_per_account = cu / (users_created + 1) as u64;
                println!("  CU: {:>10} total, ~{} CU/account", cu, cu_per_account);
            }
            Err(_) => {
                println!("  ⚠️  EXCEEDS 1.4M CU LIMIT with {} users!", users_created);
            }
        }
    }

    // Scenario 3: Find practical limit - binary search for max users
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 3: 📊 Finding practical CU limit");
    {
        let test_sizes = [100, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
        let mut last_success = 0u64;
        let mut last_success_users = 0usize;

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                break;
            }

            let mut env = TestEnv::new();
            env.init_market();

            let lp = Keypair::new();
            env.init_lp(&lp);
            env.deposit(&lp, 0, 1_000_000_000_000);

            // Bulk create users
            for i in 0..num_users {
                let user = Keypair::new();
                env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
                let ata = env.create_ata(&user.pubkey(), 0);

                let ix = Instruction {
                    program_id: env.program_id,
                    accounts: vec![
                        AccountMeta::new(user.pubkey(), true),
                        AccountMeta::new(env.slab, false),
                        AccountMeta::new(ata, false),
                        AccountMeta::new(env.vault, false),
                        AccountMeta::new_readonly(spl_token::ID, false),
                        AccountMeta::new_readonly(sysvar::clock::ID, false),
                        AccountMeta::new_readonly(env.pyth_col, false),
                    ],
                    data: encode_init_user(0),
                };
                let tx = Transaction::new_signed_with_payer(
                    &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
                );
                env.svm.send_transaction(tx).unwrap();
                env.deposit(&user, (i + 1) as u16, 1);
            }

            env.set_price(100_000_000, 200);
            match env.try_crank() {
                Ok((cu, _logs)) => {
                    let cu_per_account = cu / (num_users + 1) as u64;
                    println!("  {:>4} users: {:>10} CU (~{} CU/user)", num_users, cu, cu_per_account);
                    last_success = cu;
                    last_success_users = num_users;
                }
                Err(_) => {
                    println!("  {:>4} users: ❌ EXCEEDS 1.4M CU LIMIT", num_users);
                    break;
                }
            }
        }
        if last_success_users > 0 {
            println!("  → Max practical limit: ~{} users in single tx", last_success_users);
        }
    }

    // Scenario 4: Healthy accounts with positions (limited users)
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 4: 🟡 Healthy accounts with positions");
    {
        // Scale down for positions - they add CU overhead
        let test_sizes = [50, 100, 200, 500, 1000];

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                break;
            }

            let mut env = TestEnv::new();
            env.init_market();

            let lp = Keypair::new();
            env.init_lp(&lp);
            env.deposit(&lp, 0, 10_000_000_000_000);

            let users = create_users(&mut env, num_users, 1_000_000);

            // Add positions for each user
            for (i, user) in users.iter().enumerate() {
                let user_idx = (i + 1) as u16;
                let size = if i % 2 == 0 { 100i128 } else { -100i128 };
                env.trade(user, &lp, 0, user_idx, size);
            }

            env.set_price(100_000_000, 200);
            match env.try_crank() {
                Ok((cu, _logs)) => {
                    let cu_per_account = cu / (num_users + 1) as u64;
                    println!("  {:>4} users: {:>10} CU (~{} CU/user)", num_users, cu, cu_per_account);
                }
                Err(_) => {
                    println!("  {:>4} users: ❌ EXCEEDS 1.4M CU LIMIT", num_users);
                    break;
                }
            }
        }
    }

    // Scenario 5: 🟠 Deeply underwater (price crash triggers liquidations)
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 5: 🟠 Deeply underwater accounts (liquidations)");
    {
        let test_sizes = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                break;
            }

            let mut env = TestEnv::new();
            env.init_market();

            let lp = Keypair::new();
            env.init_lp(&lp);
            env.deposit(&lp, 0, 100_000_000_000_000);

            let users = create_users(&mut env, num_users, 1_000_000);

            // All users go long with high leverage
            for (i, user) in users.iter().enumerate() {
                let user_idx = (i + 1) as u16;
                env.trade(user, &lp, 0, user_idx, 1000i128);
            }

            // Price crashes 50% - all users deeply underwater
            env.set_price(50_000_000, 200);

            match env.try_crank() {
                Ok((cu, _logs)) => {
                    let cu_per_account = cu / (num_users + 1) as u64;
                    println!("  {:>4} liquidations: {:>10} CU (~{} CU/user)", num_users, cu, cu_per_account);
                }
                Err(_) => {
                    println!("  {:>4} liquidations: ❌ EXCEEDS 1.4M CU LIMIT", num_users);
                    break;
                }
            }
        }
    }

    // Scenario 6: 🔴 Knife-edge liquidations (worst case)
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 6: 🔴 Knife-edge liquidations (hardest case)");
    println!("  (mixed long/short at high leverage, price moves 15%)");
    {
        let test_sizes = [10, 25, 50, 100, 200];

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                break;
            }

            let mut env = TestEnv::new();
            env.init_market();

            let lp = Keypair::new();
            env.init_lp(&lp);
            env.deposit(&lp, 0, 100_000_000_000_000);

            let users = create_users(&mut env, num_users, 10_000_000);

            // Mix of long and short positions at high leverage
            for (i, user) in users.iter().enumerate() {
                let user_idx = (i + 1) as u16;
                let size = if i % 2 == 0 { 5000i128 } else { -5000i128 };
                env.trade(user, &lp, 0, user_idx, size);
            }

            // Price moves 15% - triggers some liquidations
            env.set_price(85_000_000, 200);

            match env.try_crank() {
                Ok((cu, _logs)) => {
                    let cu_per_account = cu / (num_users + 1) as u64;
                    println!("  {:>4} users at edge: {:>10} CU (~{} CU/user)", num_users, cu, cu_per_account);
                }
                Err(_) => {
                    println!("  {:>4} users at edge: ❌ EXCEEDS 1.4M CU LIMIT", num_users);
                    break;
                }
            }
        }
    }

    // Scenario 7: 🔥 Worst-case ADL (force_realize_losses with unpaid losses)
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 7: 🔥 Worst-case ADL");
    println!("  (half long/half short with varying sizes, 50% crash)");
    println!("  Losers have minimal capital → unpaid losses → apply_adl");
    {
        // Test sizes for ADL scenario
        let test_sizes = [200, 400, 600, 800, 1000, 1100, 1200, 1300, 1400, 1500];

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                break;
            }

            let mut env = TestEnv::new();

            // Use normal threshold - insurance starts at 0 which is <= 0 threshold
            // This should trigger force_realize_losses path when there are unpaid losses
            // warmup_period > 0 so winners' PnL stays unwrapped
            env.init_market_with_params(0, 100); // threshold=0, warmup=100 slots

            let lp = Keypair::new();
            env.init_lp(&lp);
            // LP needs huge capital to take the other side of all trades
            env.deposit(&lp, 0, 1_000_000_000_000_000);

            // Create users: half will be winners, half losers
            // Winners (shorts): deposit minimal capital, will have positive PnL after crash
            // Losers (longs): deposit zero/minimal capital, will have unpaid losses
            let half = num_users / 2;

            // Create all users first (without deposits for losers)
            let mut users = Vec::with_capacity(num_users);
            for i in 0..num_users {
                let user = Keypair::new();
                env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
                let ata = env.create_ata(&user.pubkey(), 0);

                let ix = Instruction {
                    program_id: env.program_id,
                    accounts: vec![
                        AccountMeta::new(user.pubkey(), true),
                        AccountMeta::new(env.slab, false),
                        AccountMeta::new(ata, false),
                        AccountMeta::new(env.vault, false),
                        AccountMeta::new_readonly(spl_token::ID, false),
                        AccountMeta::new_readonly(sysvar::clock::ID, false),
                        AccountMeta::new_readonly(env.pyth_col, false),
                    ],
                    data: encode_init_user(0),
                };
                let tx = Transaction::new_signed_with_payer(
                    &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
                );
                env.svm.send_transaction(tx).unwrap();

                let user_idx = (i + 1) as u16;

                // All users need enough margin to open positions
                // But losers will have capital wiped out by the crash
                // Size varies: (i%100+1)*10, so max size ~1000 contracts
                // At $100 price, position value = size * 100 = up to $100,000
                // With 10% initial margin, need ~$10,000 margin
                // Deposit slightly more than minimum so trade succeeds
                let deposit = if i < half {
                    // Losers (longs): just enough margin, will be wiped out
                    100_000 // minimal to pass margin check
                } else {
                    // Winners (shorts): more capital
                    10_000_000
                };
                env.deposit(&user, user_idx, deposit);

                users.push(user);
            }

            // Open positions with varying sizes (for dense remainders in ADL)
            // Longs: will lose on 50% price crash
            // Shorts: will win on 50% price crash
            for (i, user) in users.iter().enumerate() {
                let user_idx = (i + 1) as u16;
                // Size varies by index to create different unwrapped PnL values
                let base_size = ((i % 100) + 1) as i128 * 10;
                let size = if i < half {
                    base_size  // longs (losers after crash)
                } else {
                    -base_size // shorts (winners after crash)
                };
                env.trade(user, &lp, 0, user_idx, size);
            }

            // Price crashes 50% - longs lose massively, shorts win massively
            // force_realize_losses will be triggered because insurance < threshold
            // Losers have insufficient capital → unpaid losses → apply_adl
            env.set_price(50_000_000, 200); // $100 -> $50

            match env.try_crank() {
                Ok((cu, _logs)) => {
                    let cu_per_account = cu / (num_users + 1) as u64;
                    println!("  {:>4} ADL accounts: {:>10} CU (~{} CU/user)", num_users, cu, cu_per_account);
                }
                Err(e) => {
                    if e.contains("exceeded CUs") || e.contains("ProgramFailedToComplete") {
                        println!("  {:>4} ADL accounts: ❌ EXCEEDS 1.4M CU LIMIT", num_users);
                    } else {
                        println!("  {:>4} ADL accounts: ❌ {}", num_users, e);
                    }
                    break;
                }
            }
        }
    }

    // Scenario 8: 🔥🔥 Full 4096 sweep - worst single crank across 16 calls
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 8: 🔥🔥 Full sweep worst-case (16 cranks, 256 each)");
    println!("  Testing worst single crank CU across 16-crank full sweep");
    println!("  8a: Healthy accounts with positions (no liquidations)");
    {
        // Test with increasing account counts - find threshold
        let test_sizes = [100, 200, 256, 512, 768, 1024, 1536, 2048, 3072, 4095];

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                continue;
            }

            let mut env = TestEnv::new();
            env.init_market_with_params(0, 100); // warmup=100 slots

            let lp = Keypair::new();
            env.init_lp(&lp);
            env.deposit(&lp, 0, 1_000_000_000_000_000);

            // Create all users with positions (worst case = all have positions)
            let half = num_users / 2;
            let mut users = Vec::with_capacity(num_users);

            print!("  Creating {} users...", num_users);
            std::io::Write::flush(&mut std::io::stdout()).ok();

            for i in 0..num_users {
                let user = Keypair::new();
                env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
                let ata = env.create_ata(&user.pubkey(), 0);

                let ix = Instruction {
                    program_id: env.program_id,
                    accounts: vec![
                        AccountMeta::new(user.pubkey(), true),
                        AccountMeta::new(env.slab, false),
                        AccountMeta::new(ata, false),
                        AccountMeta::new(env.vault, false),
                        AccountMeta::new_readonly(spl_token::ID, false),
                        AccountMeta::new_readonly(sysvar::clock::ID, false),
                        AccountMeta::new_readonly(env.pyth_col, false),
                    ],
                    data: encode_init_user(0),
                };
                let tx = Transaction::new_signed_with_payer(
                    &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
                );
                env.svm.send_transaction(tx).unwrap();

                let user_idx = (i + 1) as u16;
                // All users get enough margin for positions
                let deposit = if i < half { 100_000 } else { 10_000_000 };
                env.deposit(&user, user_idx, deposit);
                users.push(user);
            }
            println!(" done");

            // Open positions - half long, half short (creates liquidation scenario)
            for (i, user) in users.iter().enumerate() {
                let user_idx = (i + 1) as u16;
                let base_size = ((i % 100) + 1) as i128 * 10;
                let size = if i < half { base_size } else { -base_size };
                env.trade(user, &lp, 0, user_idx, size);
            }

            // No price crash - healthy accounts
            env.set_price(100_000_000, 200);

            // Call crank 16 times and track worst CU
            let mut worst_cu: u64 = 0;
            let mut total_cu: u64 = 0;
            let mut any_failed = false;

            for crank_num in 0..16 {
                match env.try_crank() {
                    Ok((cu, _logs)) => {
                        if cu > worst_cu {
                            worst_cu = cu;
                        }
                        total_cu += cu;
                    }
                    Err(e) => {
                        if e.contains("exceeded CUs") || e.contains("ProgramFailedToComplete") {
                            println!("\n    Crank {} EXCEEDED 1.4M CU!", crank_num + 1);
                            any_failed = true;
                            break;
                        }
                        // Other errors might be OK (no work to do)
                    }
                }
            }

            if any_failed {
                println!("  {:>4} users: ❌ Single crank exceeded 1.4M CU limit", num_users);
            } else {
                let pct = (worst_cu as f64 / 1_400_000.0) * 100.0;
                println!("  {:>4} users: worst={:>10} CU ({:.1}% of limit), total={} CU across 16 cranks",
                    num_users, worst_cu, pct, total_cu);
            }
        }
    }

    // Scenario 8b: Full sweep with liquidations - find threshold
    println!("\n  8b: With 50% crash (liquidations/ADL)");
    {
        let test_sizes = [100, 200, 256, 512, 768, 1024, 1536, 2048, 3072, 4095];

        for &num_users in &test_sizes {
            if num_users >= MAX_ACCOUNTS {
                continue;
            }

            let mut env = TestEnv::new();
            env.init_market_with_params(0, 100);

            let lp = Keypair::new();
            env.init_lp(&lp);
            env.deposit(&lp, 0, 1_000_000_000_000_000);

            let half = num_users / 2;
            let mut users = Vec::with_capacity(num_users);

            print!("  Creating {} users...", num_users);
            std::io::Write::flush(&mut std::io::stdout()).ok();

            for i in 0..num_users {
                let user = Keypair::new();
                env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
                let ata = env.create_ata(&user.pubkey(), 0);

                let ix = Instruction {
                    program_id: env.program_id,
                    accounts: vec![
                        AccountMeta::new(user.pubkey(), true),
                        AccountMeta::new(env.slab, false),
                        AccountMeta::new(ata, false),
                        AccountMeta::new(env.vault, false),
                        AccountMeta::new_readonly(spl_token::ID, false),
                        AccountMeta::new_readonly(sysvar::clock::ID, false),
                        AccountMeta::new_readonly(env.pyth_col, false),
                    ],
                    data: encode_init_user(0),
                };
                let tx = Transaction::new_signed_with_payer(
                    &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
                );
                env.svm.send_transaction(tx).unwrap();

                let user_idx = (i + 1) as u16;
                let deposit = if i < half { 100_000 } else { 10_000_000 };
                env.deposit(&user, user_idx, deposit);
                users.push(user);
            }
            println!(" done");

            for (i, user) in users.iter().enumerate() {
                let user_idx = (i + 1) as u16;
                let base_size = ((i % 100) + 1) as i128 * 10;
                let size = if i < half { base_size } else { -base_size };
                env.trade(user, &lp, 0, user_idx, size);
            }

            // 50% price crash - triggers liquidations
            env.set_price(50_000_000, 200);

            let mut worst_cu: u64 = 0;
            let mut total_cu: u64 = 0;
            let mut any_failed = false;
            let mut last_logs: Vec<String> = Vec::new();

            for crank_num in 0..16 {
                match env.try_crank() {
                    Ok((cu, logs)) => {
                        if cu > worst_cu {
                            worst_cu = cu;
                        }
                        total_cu += cu;
                        last_logs = logs;
                    }
                    Err(e) => {
                        if e.contains("exceeded CUs") || e.contains("ProgramFailedToComplete") {
                            println!("\n    Crank {} EXCEEDED 1.4M CU!", crank_num + 1);
                            any_failed = true;
                            break;
                        }
                    }
                }
            }

            if any_failed {
                println!("  {:>4} users: ❌ Single crank exceeded 1.4M CU limit", num_users);
            } else {
                let pct = (worst_cu as f64 / 1_400_000.0) * 100.0;
                // Extract CRANK_STATS from logs - sol_log_64 format: "Program log: 0xtag, 0xliqs, 0xforce, 0xmax_accounts, 0x0"
                let mut liquidations: u64 = 0;
                let mut force_realize: u64 = 0;
                let mut max_accounts: u64 = 0;
                let mut found_stats = false;

                // Helper to parse hex or decimal
                fn parse_hex_or_dec(s: &str) -> u64 {
                    let s = s.trim();
                    if let Some(hex) = s.strip_prefix("0x") {
                        u64::from_str_radix(hex, 16).unwrap_or(0)
                    } else {
                        s.parse().unwrap_or(0)
                    }
                }

                for (i, log) in last_logs.iter().enumerate() {
                    if log.contains("CRANK_STATS") {
                        // Next log line should have the sol_log_64 output
                        if i + 1 < last_logs.len() {
                            let next_log = &last_logs[i + 1];
                            // Format: "Program log: 0xc8a4c, 0x0, 0x200, 0x1000, 0x0"
                            if let Some(rest) = next_log.strip_prefix("Program log: ") {
                                let parts: Vec<&str> = rest.split(", ").collect();
                                if parts.len() >= 4 {
                                    liquidations = parse_hex_or_dec(parts[1]);
                                    force_realize = parse_hex_or_dec(parts[2]);
                                    max_accounts = parse_hex_or_dec(parts[3]);
                                    found_stats = true;
                                }
                            }
                        }
                    }
                }
                if found_stats {
                    println!("  {:>4} users: worst={:>10} CU ({:.1}%), total={} | liqs={} force={} max_acc={}",
                        num_users, worst_cu, pct, total_cu, liquidations, force_realize, max_accounts);
                } else {
                    println!("  {:>4} users: worst={:>10} CU ({:.1}% of limit), total={} CU across 16 cranks",
                        num_users, worst_cu, pct, total_cu);
                }
            }
        }
    }

    // Scenario 9: Worst-case liquidation with late-window underwater accounts
    // Tests true liquidation path with MTM margin check (insurance > threshold)
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Scenario 9: 🔥🔥🔥 Worst-case liquidation (MTM margin check)");
    println!("  1 LP + 4095 users, insurance > threshold for liquidation path");
    println!("  Each window: first half safe, second half deeply underwater");
    {
        let num_users = 4095;

        let mut env = TestEnv::new();
        // threshold=0, warmup=0
        env.init_market_with_params(0, 0);

        // Top up insurance so force_realize is OFF and liquidation path runs
        let insurance_funder = Keypair::new();
        env.svm.airdrop(&insurance_funder.pubkey(), 1_000_000_000).unwrap();
        env.top_up_insurance(&insurance_funder, 1_000_000_000); // 1B tokens

        let lp = Keypair::new();
        env.init_lp(&lp);
        // LP needs massive collateral to absorb all user positions
        env.deposit(&lp, 0, 100_000_000_000_000_000); // 100M tokens

        println!("  Creating {} users with varied collateral...", num_users);

        // Create users: for each 256-account window, first 128 are "safe", last 128 are "liq"
        // Safe users: more collateral, smaller position -> stay above maintenance
        // Liq users: less collateral, same position -> fall below maintenance
        let mut users = Vec::with_capacity(num_users);

        for i in 0..num_users {
            let user = Keypair::new();
            env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();

            // Create ATA (fee=0 since new_account_fee in params is 0)
            let ata = env.create_ata(&user.pubkey(), 0);

            let ix = Instruction {
                program_id: env.program_id,
                accounts: vec![
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new(env.slab, false),
                    AccountMeta::new(ata, false),
                    AccountMeta::new(env.vault, false),
                    AccountMeta::new_readonly(spl_token::ID, false),
                    AccountMeta::new_readonly(sysvar::clock::ID, false),
                    AccountMeta::new_readonly(env.pyth_col, false),
                ],
                data: encode_init_user(0),
            };
            let tx = Transaction::new_signed_with_payer(
                &[ix], Some(&user.pubkey()), &[&user], env.svm.latest_blockhash(),
            );
            env.svm.send_transaction(tx).unwrap();

            let user_idx = (i + 1) as u16;

            // Determine if this user is in "safe" or "liq" half of their window
            let window_offset = i % 256;
            let is_liq_user = window_offset >= 128;

            // Position: 1000 contracts at $100 = 100K notional
            // Initial margin 10% = 10K (need capital >= 10K)
            // After 50% crash: notional = 50K, loss = 50K
            // Maintenance 5% of 50K = 2.5K
            // For liquidation: equity = capital - 50K < 2.5K → capital < 52.5K
            // Liq users: 50K capital (after 50K loss, equity = 0 < 2.5K → liquidatable)
            // Safe users: 1M capital (after 50K loss, equity = 950K >> 2.5K → safe)
            let deposit = if is_liq_user { 50_000u64 } else { 1_000_000u64 };
            env.deposit(&user, user_idx, deposit);

            users.push(user);

            if (i + 1) % 1000 == 0 {
                println!("    Created {} users...", i + 1);
            }
        }
        println!("    Created {} users total", num_users);

        // Open positions: all users go long with same size
        // Try 1000 contracts like Scenario 5 - with 10K liq collateral should go underwater
        // Safe users (10B) will easily survive, liq users (10K) should be liquidated
        println!("  Opening positions (all users long)...");
        let position_size = 1000i128; // 1K contracts like Scenario 5

        for (i, user) in users.iter().enumerate() {
            let user_idx = (i + 1) as u16;
            env.trade(user, &lp, 0, user_idx, position_size);

            if (i + 1) % 1000 == 0 {
                println!("    Opened {} positions...", i + 1);
            }
        }

        // Price crash: $100 -> $50 (50% drop)
        // Longs lose 50% of position value ($5K loss on $10K position)
        // Safe users (1B collateral) should survive
        // Liq users (1K collateral) should be underwater and liquidated
        println!("  Crashing price 50%: $100 -> $50");
        env.set_price(50_000_000, 200);

        // Run enough cranks to close all liq users
        // FORCE_REALIZE_BUDGET_PER_CRANK=32, ~2048 liq users → need ~64 cranks
        println!("  Running 64 cranks (32 force_realize per crank)...");
        let mut worst_cu: u64 = 0;
        let mut total_cu: u64 = 0;
        let mut total_liqs: u64 = 0;
        let mut total_force: u64 = 0;
        let mut any_failed = false;
        let mut last_max_acc: u64 = 0;
        let mut last_insurance: u64 = 0;

        // Helper to parse hex or decimal
        fn parse_hex_or_dec(s: &str) -> u64 {
            let s = s.trim();
            if let Some(hex) = s.strip_prefix("0x") {
                u64::from_str_radix(hex, 16).unwrap_or(0)
            } else {
                s.parse().unwrap_or(0)
            }
        }

        for crank_num in 0..64 {
            match env.try_crank() {
                Ok((cu, logs)) => {
                    if cu > worst_cu {
                        worst_cu = cu;
                    }
                    total_cu += cu;

                    // Parse stats from logs
                    for (i, log) in logs.iter().enumerate() {
                        if log.contains("CRANK_STATS") {
                            if i + 1 < logs.len() {
                                let next_log = &logs[i + 1];
                                if let Some(rest) = next_log.strip_prefix("Program log: ") {
                                    let parts: Vec<&str> = rest.split(", ").collect();
                                    if parts.len() >= 5 {
                                        let liqs = parse_hex_or_dec(parts[1]);
                                        let force = parse_hex_or_dec(parts[2]);
                                        last_max_acc = parse_hex_or_dec(parts[3]);
                                        last_insurance = parse_hex_or_dec(parts[4]);
                                        total_liqs = liqs;  // cumulative from engine
                                        total_force = force;

                                        println!("    Crank {:>2}: {:>7} CU | liqs={} force={}",
                                            crank_num + 1, cu, liqs, force);
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    if e.contains("exceeded CUs") || e.contains("ProgramFailedToComplete") {
                        println!("    Crank {} EXCEEDED 1.4M CU!", crank_num + 1);
                        any_failed = true;
                        break;
                    } else {
                        println!("    Crank {} error: {}", crank_num + 1, e);
                    }
                }
            }
        }

        println!();
        if any_failed {
            println!("  ❌ FAILED: Single crank exceeded 1.4M CU limit");
        } else {
            let pct = (worst_cu as f64 / 1_400_000.0) * 100.0;
            println!("  ✓ RESULT: worst={} CU ({:.1}%), total={} CU", worst_cu, pct, total_cu);
            println!("    Liquidations: {}, Force-realize: {}", total_liqs, total_force);
            println!("    MAX_ACCOUNTS: {}", last_max_acc);
            if total_liqs == 0 && total_force == 0 {
                println!("    ⚠️  WARNING: No liquidations or force-realize - check params");
            }
            // Expected: ~2048 liquidations (half of 4095 users are liq users)
            let expected_liq = num_users / 2;
            if total_liqs > 0 {
                println!("    ✓ MTM margin check working - {} liquidations triggered", total_liqs);
            }
        }
    }

    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("=== SUMMARY ===");
    println!("• Crank sweeps 256 accounts max per call (16 cranks for full 4096)");
    println!("• With MAX_ACCOUNTS={}, baseline scan alone is ~194K CU", MAX_ACCOUNTS);
    println!("• Key metric: worst single crank must stay under 1.4M CU");
    println!("• ADL/liquidation processing adds CU overhead per affected account");
}
