//! Oracle for the app's size-aware spread quote: drives the DEPLOYED matcher math (release/v22-matcher 7d5aa26) with a REAL
//! devnet context (bytes from the env file) and the wrapper's ext-v3 caps, and prints what it charges.
use percolator_match::v2::{CallExt, ExtCapsV3};
use percolator_match::vamm::{self, MatcherCtx};
use percolator_match::{CTX_VAMM_OFFSET, MATCHER_CALL_V3_LEN};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use std::io::Write;

static NOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn clock() -> Result<u64, ProgramError> { Ok(NOW.load(std::sync::atomic::Ordering::SeqCst)) }

fn b64(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![]; let mut buf = 0u32; let mut n = 0;
    for c in s.bytes() { if c == b'=' { break; } let v = T.iter().position(|&x| x == c).unwrap() as u32; buf = (buf << 6) | v; n += 6; if n >= 8 { n -= 8; out.push((buf >> n) as u8); buf &= (1 << n) - 1; } }
    out
}

#[test]
fn oracle() {
    let st: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("R10_STATE").unwrap()).unwrap()).unwrap();
    let ctx_bytes = b64(st["ctxB64"].as_str().unwrap());
    let px: u64 = std::env::var("R10_PX").unwrap().parse().unwrap();
    let now: u64 = std::env::var("R10_SLOT").unwrap().parse().unwrap();
    let lp_pos: i128 = std::env::var("R10_LP_POS").unwrap().parse().unwrap();
    let cap: u128 = std::env::var("R10_CAP").unwrap().parse().unwrap();
    let liq: u128 = std::env::var("R10_LIQ").unwrap().parse().unwrap();
    NOW.store(now, std::sync::atomic::Ordering::SeqCst);
    let lp_id = MatcherCtx::read_from(&ctx_bytes[CTX_VAMM_OFFSET..]).unwrap().lp_account_id;
    let mut out = vec![];
    for (side, buy) in [("buy", true), ("sell", false)] {
        for reducing in [false, true] {
            for usd in [20u128, 100, 400, 650, 1000, 1255, 2000, 4000] {
                let q = (usd * 1_000_000 * 1_000_000 / px as u128) as i128;
                let size = if buy { q } else { -q };
                let mut d = vec![0u8; MATCHER_CALL_V3_LEN];
                d[1..9].copy_from_slice(&1u64.to_le_bytes());
                d[11..19].copy_from_slice(&lp_id.to_le_bytes());
                d[19..27].copy_from_slice(&px.to_le_bytes());
                d[27..43].copy_from_slice(&size.to_le_bytes());
                let e = CallExt { lp_position_q: Some(lp_pos), mark_slot: Some(now), taker_reducing: reducing, ..CallExt::default() };
                d[43..115].copy_from_slice(&e.encode_v3(&ExtCapsV3 { inventory_cap_q: cap, liquidity_notional_e6: liq }));
                let prog = Pubkey::new_unique();
                let lp = Pubkey::new_from_array(MatcherCtx::read_from(&ctx_bytes[CTX_VAMM_OFFSET..]).unwrap().lp_pda);
                let key = Pubkey::new_unique();
                let mut buf = ctx_bytes.clone();
                let mut lam = 1u64; let mut lpl = 0u64;
                let lp_ai = AccountInfo::new(&lp, true, false, &mut lpl, &mut [], &prog, false, 0);
                let ctx_ai = AccountInfo::new(&key, false, true, &mut lam, &mut buf, &prog, false, 0);
                let r: Result<(), ProgramError> = vamm::process_call_with_clock(&lp_ai, &ctx_ai, &d, clock);
                drop(ctx_ai);
                match r {
                    Ok(()) => {
                        let price = u64::from_le_bytes(buf[8..16].try_into().unwrap());
                        let sz = i128::from_le_bytes(buf[16..32].try_into().unwrap());
                        out.push(format!("{{\"side\":\"{side}\",\"reducing\":{reducing},\"usd\":{usd},\"sizeQ\":\"{q}\",\"execPriceE6\":\"{price}\",\"execSize\":\"{sz}\"}}"));
                    }
                    Err(e) => out.push(format!("{{\"side\":\"{side}\",\"reducing\":{reducing},\"usd\":{usd},\"sizeQ\":\"{q}\",\"err\":\"{e:?}\"}}")),
                }
            }
        }
    }
    let mut f = std::fs::File::create(std::env::var("R10_OUT").unwrap()).unwrap();
    writeln!(f, "[{}]", out.join(",\n")).unwrap();
}
