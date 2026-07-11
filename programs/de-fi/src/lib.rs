use anchor_lang::prelude::*;

use crate::instructions::{admin, liquidity, staking};
use crate::instructions::*;
use crate::state::ActionType;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

declare_id!("FDwF1iC4FYJrAMK9ns7pSUjZdhaZRjQ857bsaQEyZ7B1");

#[program]
pub mod defi {
    use super::*;

    pub fn initialize_state(
        ctx: Context<InitializeState>,
        signer1: Pubkey,
        signer2: Pubkey,
        signer3: Pubkey,
        timelock_delay: i64,
    ) -> Result<()> {
        admin::initialize_state(ctx, signer1, signer2, signer3, timelock_delay)
    }

    pub fn initialize_sol_accounts(ctx: Context<InitializeSolAccounts>) -> Result<()> {
        admin::initialize_sol_accounts(ctx)
    }

    pub fn initialize_usdc_accounts(ctx: Context<InitializeUsdcAccounts>) -> Result<()> {
        admin::initialize_usdc_accounts(ctx)
    }

    pub fn fund_reward_vault(
        ctx: Context<FundRewardVault>,
        amount: u64,
        token_type: u8,
    ) -> Result<()> {
        admin::fund_reward_vault(ctx, amount, token_type)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64, token_type: u8) -> Result<()> {
        staking::stake(ctx, amount, token_type)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64, token_type: u8) -> Result<()> {
        staking::unstake(ctx, amount, token_type)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>, token_type: u8) -> Result<()> {
        staking::claim_rewards(ctx, token_type)
    }

    pub fn close_stake_account(_ctx: Context<CloseStakeAccount>, token_type: u8) -> Result<()> {
        staking::close_stake_account(_ctx, token_type)
    }

    pub fn emergency_unstake(ctx: Context<EmergencyUnstake>, token_type: u8) -> Result<()> {
        staking::emergency_unstake(ctx, token_type)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        admin::unpause(ctx)
    }

    pub fn propose_action(
        ctx: Context<ProposeAction>,
        action_type: ActionType,
        data: Vec<u8>,
    ) -> Result<()> {
        admin::propose_action(ctx, action_type, data)
    }

    pub fn approve_action(ctx: Context<ApproveAction>) -> Result<()> {
        admin::approve_action(ctx)
    }

    pub fn cancel_action(ctx: Context<CancelAction>) -> Result<()> {
        admin::cancel_action(ctx)
    }

    pub fn update_reward_rate(ctx: Context<UpdateRewardRate>) -> Result<()> {
        admin::update_reward_rate(ctx)
    }

    pub fn update_flash_loan_callback_program(
        ctx: Context<UpdateFlashLoanCallbackProgram>,
    ) -> Result<()> {
        admin::update_flash_loan_callback_program(ctx)
    }

    pub fn create_pool(ctx: Context<CreatePool>, fee_basis_points: u16) -> Result<()> {
        liquidity::create_pool(ctx, fee_basis_points)
    }

    pub fn flash_loan<'info>(
        ctx: Context<'_, '_, '_, 'info, FlashLoan<'info>>,
        amount: u64,
        borrower_program_id: Pubkey,
    ) -> Result<()> {
        liquidity::flash_loan(ctx, amount, borrower_program_id)
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_to_mint: u64,
    ) -> Result<()> {
        liquidity::add_liquidity(ctx, amount_a, amount_b, min_lp_to_mint)
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_amount_a: u64,
        min_amount_b: u64,
    ) -> Result<()> {
        liquidity::remove_liquidity(ctx, lp_amount, min_amount_a, min_amount_b)
    }

    pub fn emergency_remove_liquidity(
        ctx: Context<EmergencyRemoveLiquidity>,
        lp_amount: u64,
    ) -> Result<()> {
        liquidity::emergency_remove_liquidity(ctx, lp_amount)
    }

    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64) -> Result<()> {
        liquidity::swap(ctx, amount_in, min_amount_out)
    }

    pub fn update_rewards(ctx: Context<UpdateRewards>, token_type: u8) -> Result<()> {
        staking::update_rewards(ctx, token_type)
    }
}
