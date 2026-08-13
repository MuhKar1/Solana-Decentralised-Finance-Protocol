use anchor_lang::prelude::*;

use crate::errors::ErrorCode;

pub mod pool;

pub use pool::*;

pub const PRECISION: u128 = 1_000_000_000_000_000_000;
pub const MAX_REWARD_RATE: u64 = 1_000_000;
pub const MAX_TIMELOCK_DELAY: i64 = 2_592_000;
pub const MIN_STAKE_AMOUNT: u64 = 1_000_000_000;
pub const MINIMUM_LIQUIDITY: u64 = 1_000;
pub const NORMALIZED_DECIMALS: u32 = 9;

fn get_normalized_total_staked(state: &Account<ProgramState>) -> Result<u128> {
    // Both SOL (9 decimals) and USDC (6 decimals) are already expressed in the
    // same raw "base unit" magnitude (see TokenKind::normalize_amount).
    // No decimal rescaling is required; 1e9 raw units == 1 SOL == 1,000 USDC.
    Ok((state.total_staked_sol as u128)
        .checked_add(state.total_staked_usdc as u128)
        .ok_or(ErrorCode::Overflow)?)
}

pub fn update_global_rewards(state: &mut Account<ProgramState>) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;
    let total_staked = get_normalized_total_staked(state)?;

    if current_time > state.last_update_time && total_staked > 0 {
        let time_elapsed = (current_time - state.last_update_time) as u128;
        let time_elapsed_capped = time_elapsed.min(86400);

        let reward = time_elapsed_capped
            .checked_mul(state.reward_rate as u128)
            .ok_or(ErrorCode::Overflow)?;

        let reward_per_token_delta = reward
            .checked_mul(state.precision)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(total_staked)
            .ok_or(ErrorCode::Overflow)?;

        state.reward_per_token_stored = state
            .reward_per_token_stored
            .checked_add(reward_per_token_delta)
            .ok_or(ErrorCode::Overflow)?;
    }

    state.last_update_time = current_time;
    Ok(())
}

pub fn update_rewards_internal(
    state: &mut Account<ProgramState>,
    user_stake: &mut Account<UserStake>,
) -> Result<()> {
    update_global_rewards(state)?;

    if user_stake.staked_amount > 0 {
        let token_kind = TokenKind::from_u8(user_stake.token_type)?;
        let normalized_user_stake = token_kind.normalize_amount(user_stake.staked_amount)?;

        let reward_for_user = normalized_user_stake
            .checked_mul(
                state
                    .reward_per_token_stored
                    .checked_sub(user_stake.reward_per_token_paid)
                    .ok_or(ErrorCode::Underflow)?,
            )
            .ok_or(ErrorCode::Overflow)?;

        let pending = reward_for_user
            .checked_div(state.precision)
            .ok_or(ErrorCode::Overflow)? as u64;

        user_stake.pending_rewards = user_stake
            .pending_rewards
            .checked_add(pending)
            .ok_or(ErrorCode::Overflow)?;
    }

    user_stake.reward_per_token_paid = state.reward_per_token_stored;
    Ok(())
}

/// Validate the three multisig signers at initialization:
///   - no signer may be the zero (default) pubkey,
///   - all three must be unique,
///   - the required threshold must not exceed the number of valid signers.
///
/// Extracted as a pure function so it can be unit-tested independently of
/// on-chain account state.
pub fn validate_multisig_signers(s1: Pubkey, s2: Pubkey, s3: Pubkey) -> Result<()> {
    require!(s1 != Pubkey::default(), ErrorCode::InvalidMultisigSigner);
    require!(s2 != Pubkey::default(), ErrorCode::InvalidMultisigSigner);
    require!(s3 != Pubkey::default(), ErrorCode::InvalidMultisigSigner);

    require!(s1 != s2, ErrorCode::DuplicateSigner);
    require!(s1 != s3, ErrorCode::DuplicateSigner);
    require!(s2 != s3, ErrorCode::DuplicateSigner);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(b: u8) -> Pubkey {
        let mut arr = [0u8; 32];
        arr[0] = b;
        Pubkey::new_from_array(arr)
    }

    #[test]
    fn rejects_zero_signer1() {
        assert_eq!(
            validate_multisig_signers(Pubkey::default(), pk(2), pk(3)).unwrap_err(),
            ErrorCode::InvalidMultisigSigner.into()
        );
    }

    #[test]
    fn rejects_zero_signer2() {
        assert_eq!(
            validate_multisig_signers(pk(1), Pubkey::default(), pk(3)).unwrap_err(),
            ErrorCode::InvalidMultisigSigner.into()
        );
    }

    #[test]
    fn rejects_zero_signer3() {
        assert_eq!(
            validate_multisig_signers(pk(1), pk(2), Pubkey::default()).unwrap_err(),
            ErrorCode::InvalidMultisigSigner.into()
        );
    }

    #[test]
    fn rejects_signer1_equals_signer2() {
        assert_eq!(
            validate_multisig_signers(pk(1), pk(1), pk(3)).unwrap_err(),
            ErrorCode::DuplicateSigner.into()
        );
    }

    #[test]
    fn rejects_signer1_equals_signer3() {
        assert_eq!(
            validate_multisig_signers(pk(1), pk(2), pk(1)).unwrap_err(),
            ErrorCode::DuplicateSigner.into()
        );
    }

    #[test]
    fn rejects_signer2_equals_signer3() {
        assert_eq!(
            validate_multisig_signers(pk(1), pk(2), pk(2)).unwrap_err(),
            ErrorCode::DuplicateSigner.into()
        );
    }

    #[test]
    fn accepts_three_unique_signers() {
        assert!(validate_multisig_signers(pk(1), pk(2), pk(3)).is_ok());
    }
}
