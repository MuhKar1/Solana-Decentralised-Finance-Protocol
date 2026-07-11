use anchor_lang::prelude::*;

use crate::errors::ErrorCode;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PendingAction {
    pub action_type: ActionType,
    pub proposed_at: i64,
    pub data: Vec<u8>,
    pub approvals: [bool; 3],
    pub created_by: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum ActionType {
    Pause,
    Unpause,
    UpdateRewardRate,
    UpdateFlashLoanCallbackProgram,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Sol,
    Usdc,
}

impl TokenKind {
    pub fn from_u8(token_type: u8) -> Result<Self> {
        match token_type {
            0 => Ok(Self::Sol),
            1 => Ok(Self::Usdc),
            _ => err!(ErrorCode::InvalidTokenType),
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Self::Sol => 0,
            Self::Usdc => 1,
        }
    }

    pub fn is_sol(self) -> bool {
        self == Self::Sol
    }

    pub fn staking_pool_seed(self) -> &'static [u8] {
        match self {
            Self::Sol => b"staking_pool_sol",
            Self::Usdc => b"staking_pool_usdc",
        }
    }

    pub fn staking_pool_bump(self, state: &ProgramState) -> u8 {
        match self {
            Self::Sol => state.staking_pool_sol_bump,
            Self::Usdc => state.staking_pool_usdc_bump,
        }
    }

    pub fn reward_vault_seed(self) -> &'static [u8] {
        match self {
            Self::Sol => b"reward_vault_sol",
            Self::Usdc => b"reward_vault_usdc",
        }
    }

    pub fn reward_vault_bump(self, state: &ProgramState) -> u8 {
        match self {
            Self::Sol => state.reward_vault_sol_bump,
            Self::Usdc => state.reward_vault_usdc_bump,
        }
    }

    pub fn normalize_amount(self, amount: u64) -> Result<u128> {
        match self {
            Self::Sol => Ok(amount as u128),
            Self::Usdc => (amount as u128)
                .checked_mul(10u128.pow(super::NORMALIZED_DECIMALS - 6))
                .ok_or(ErrorCode::Overflow.into()),
        }
    }
}

#[account]
#[derive(Default)]
pub struct ProgramState {
    pub authority: Pubkey,
    pub signer1: Pubkey,
    pub signer2: Pubkey,
    pub signer3: Pubkey,
    pub required_signatures: u8,
    pub total_staked_sol: u64,
    pub total_staked_usdc: u64,
    pub paused: bool,
    pub reward_rate: u64,
    pub total_rewards_distributed: u64,
    pub staking_pool_sol_bump: u8,
    pub staking_pool_usdc_bump: u8,
    pub reward_vault_sol_bump: u8,
    pub reward_vault_usdc_bump: u8,
    pub treasury_sol_bump: u8,
    pub treasury_usdc_bump: u8,
    pub last_update_time: i64,
    pub reward_per_token_stored: u128,
    pub timelock_delay: i64,
    pub pending_action: Option<PendingAction>,
    pub upgrade_version: u8,
    pub precision: u128,
    pub min_stake_amount: u64,
    pub protocol_fee_basis_points: u16,
    pub flash_loan_callback_program: Pubkey,
}

#[account]
#[derive(Default)]
pub struct UserStake {
    pub user: Pubkey,
    pub staked_amount: u64,
    pub reward_per_token_paid: u128,
    pub pending_rewards: u64,
    pub token_type: u8,
}

#[account]
#[derive(Default)]
pub struct Pool {
    pub bump: u8,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_account: Pubkey,
    pub token_b_account: Pubkey,
    pub lp_token_mint: Pubkey,
    pub fee_basis_points: u16,
    pub k_last: u128,
    pub flash_loan_fee_basis_points: u16,
}