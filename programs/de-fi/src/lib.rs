use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("FDwF1iC4FYJrAMK9ns7pSUjZdhaZRjQ857bsaQEyZ7B1");

// Precision for reward calculations
const PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18

// Cap reward rate updates to prevent accumulator overflow risk
const MAX_REWARD_RATE: u64 = 1_000_000;

// Maximum timelock delay (30 days)
const MAX_TIMELOCK_DELAY: i64 = 2_592_000;

// Minimum stake amount to prevent dust attacks and gas griefing
const MIN_STAKE_AMOUNT: u64 = 1_000_000_000; // 1 SOL in lamports

// Uniswap V2 standard minimum liquidity
const MINIMUM_LIQUIDITY: u64 = 1_000;

// Decimal normalization for cross-token staking rewards
const NORMALIZED_DECIMALS: u32 = 9;

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub token_a: Pubkey,
    pub token_b: Pubkey,
    pub lp_mint: Pubkey,
}

#[event]
pub struct LiquidityAdded {
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_tokens: u64,
}

#[event]
pub struct StakeEvent {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct UnstakeEvent {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ClaimEvent {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EmergencyUnstakeEvent {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EmergencyRemoveLiquidityEvent {
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_amount: u64,
}

#[event]
pub struct SwapEvent {
    pub user: Pubkey,
    pub token_in: Pubkey,
    pub token_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PendingAction {
    pub action_type: ActionType,
    pub proposed_at: i64,
    pub data: Vec<u8>,
    pub approvals: [bool; 3], // Track approval for signer1, signer2, signer3
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
enum TokenKind {
    Sol,
    Usdc,
}

impl TokenKind {
    fn from_u8(token_type: u8) -> Result<Self> {
        match token_type {
            0 => Ok(Self::Sol),
            1 => Ok(Self::Usdc),
            _ => err!(ErrorCode::InvalidTokenType),
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Sol => 0,
            Self::Usdc => 1,
        }
    }

    fn is_sol(self) -> bool {
        self == Self::Sol
    }

    fn staking_pool_seed(self) -> &'static [u8] {
        match self {
            Self::Sol => b"staking_pool_sol",
            Self::Usdc => b"staking_pool_usdc",
        }
    }

    fn staking_pool_bump(self, state: &ProgramState) -> u8 {
        match self {
            Self::Sol => state.staking_pool_sol_bump,
            Self::Usdc => state.staking_pool_usdc_bump,
        }
    }

    fn reward_vault_seed(self) -> &'static [u8] {
        match self {
            Self::Sol => b"reward_vault_sol",
            Self::Usdc => b"reward_vault_usdc",
        }
    }

    fn reward_vault_bump(self, state: &ProgramState) -> u8 {
        match self {
            Self::Sol => state.reward_vault_sol_bump,
            Self::Usdc => state.reward_vault_usdc_bump,
        }
    }

    fn normalize_amount(self, amount: u64) -> Result<u128> {
        match self {
            Self::Sol => Ok(amount as u128),
            Self::Usdc => (amount as u128)
                .checked_mul(10u128.pow(NORMALIZED_DECIMALS - 6))
                .ok_or(ErrorCode::Overflow.into()),
        }
    }
}

#[program]
pub mod defi {
    use super::*;

    // Step 1: Initialize core state (no token accounts to stay under stack limit)
    pub fn initialize_state(
        ctx: Context<InitializeState>,
        signer1: Pubkey,
        signer2: Pubkey,
        signer3: Pubkey,
        timelock_delay: i64,
    ) -> Result<()> {
        require!(
            timelock_delay >= 0 && timelock_delay <= MAX_TIMELOCK_DELAY,
            ErrorCode::InvalidAmount
        );

        let state = &mut ctx.accounts.state;
        state.authority = ctx.accounts.authority.key();
        state.signer1 = signer1;
        state.signer2 = signer2;
        state.signer3 = signer3;
        state.required_signatures = 3;
        state.paused = false;
        state.reward_rate = 10;
        state.total_staked_sol = 0;
        state.total_staked_usdc = 0;
        state.total_rewards_distributed = 0;
        state.last_update_time = Clock::get()?.unix_timestamp;
        state.reward_per_token_stored = 0;
        state.timelock_delay = timelock_delay;
        state.pending_action = None;
        state.upgrade_version = 1;
        state.precision = PRECISION;
        state.min_stake_amount = MIN_STAKE_AMOUNT;
        state.protocol_fee_basis_points = 100;
        state.flash_loan_callback_program = Pubkey::default();

        msg!("DeFi program state initialized");
        Ok(())
    }

    // Step 2: Initialize SOL-related accounts
    pub fn initialize_sol_accounts(ctx: Context<InitializeSolAccounts>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.staking_pool_sol_bump = ctx.bumps.staking_pool_sol;
        state.reward_vault_sol_bump = ctx.bumps.reward_vault_sol;
        state.treasury_sol_bump = ctx.bumps.protocol_treasury_sol;

        msg!("SOL accounts initialized");
        Ok(())
    }

    // Step 3: Initialize USDC-related accounts
    pub fn initialize_usdc_accounts(ctx: Context<InitializeUsdcAccounts>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.staking_pool_usdc_bump = ctx.bumps.staking_pool_usdc;
        state.reward_vault_usdc_bump = ctx.bumps.reward_vault_usdc;
        state.treasury_usdc_bump = ctx.bumps.protocol_treasury_usdc;

        msg!("USDC accounts initialized");
        Ok(())
    }

    // Admin: Fund the reward vault
    pub fn fund_reward_vault(
        ctx: Context<FundRewardVault>,
        amount: u64,
        token_type: u8,
    ) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.state.authority,
            ErrorCode::Unauthorized
        );
        require!(amount > 0, ErrorCode::InvalidAmount);
        let token_kind = TokenKind::from_u8(token_type)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_token_account.to_account_info(),
                    to: ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;

        msg!(
            "Funded reward vault with {} tokens for token type {}",
            amount,
            token_kind.as_u8()
        );
        Ok(())
    }

    // Staking: Stake tokens
    pub fn stake(ctx: Context<Stake>, amount: u64, token_type: u8) -> Result<()> {
        msg!(
            "Stake called with amount: {}, token_type: {}",
            amount,
            token_type
        );
        msg!("User key: {}", ctx.accounts.user.key());
        msg!("User stake PDA: {}", ctx.accounts.user_stake.key());

        let state = &mut ctx.accounts.state;
        let user_stake = &mut ctx.accounts.user_stake;

        require!(!state.paused, ErrorCode::Paused);
        require!(amount > 0, ErrorCode::InvalidAmount);
        let token_kind = TokenKind::from_u8(token_type)?;

        // Enforce minimum stake amount to prevent dust attacks
        if amount < state.min_stake_amount {
            msg!(
                "Stake amount {} below minimum required {}",
                amount,
                state.min_stake_amount
            );
            return err!(ErrorCode::InsufficientAmount);
        }

        // Update rewards *before* changing stake
        update_rewards_internal(state, user_stake)?;

        // On first stake, set the user and initialize reward tracking
        if user_stake.staked_amount == 0 {
            user_stake.user = ctx.accounts.user.key();
            user_stake.token_type = token_kind.as_u8();
            // Sets their "starting point" to the current global value
            user_stake.reward_per_token_paid = state.reward_per_token_stored;
        } else {
            require!(
                user_stake.token_type == token_kind.as_u8(),
                ErrorCode::InvalidTokenType
            );
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.staking_pool.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update state based on token type
        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_add(amount)
            .ok_or(ErrorCode::Overflow)?;
        if token_kind.is_sol() {
            state.total_staked_sol = state
                .total_staked_sol
                .checked_add(amount)
                .ok_or(ErrorCode::Overflow)?;
        } else {
            state.total_staked_usdc = state
                .total_staked_usdc
                .checked_add(amount)
                .ok_or(ErrorCode::Overflow)?;
        }

        emit!(StakeEvent {
            user: ctx.accounts.user.key(),
            amount,
        });

        let total_staked = state
            .total_staked_sol
            .checked_add(state.total_staked_usdc)
            .unwrap_or(0);
        msg!(
            "Staked {} tokens (type: {}). Total staked: {}",
            amount,
            token_kind.as_u8(),
            total_staked
        );
        Ok(())
    }

    // Staking: Unstake tokens
    pub fn unstake(ctx: Context<Unstake>, amount: u64, token_type: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let user_stake = &mut ctx.accounts.user_stake;

        require!(!state.paused, ErrorCode::Paused);
        require!(amount > 0, ErrorCode::InvalidAmount);
        let token_kind = TokenKind::from_u8(token_type)?;
        require!(
            user_stake.staked_amount >= amount,
            ErrorCode::InsufficientBalance
        );
        require!(
            user_stake.token_type == token_kind.as_u8(),
            ErrorCode::InvalidTokenType
        );

        // Update rewards *before* changing stake
        update_rewards_internal(state, user_stake)?;

        let bump = token_kind.staking_pool_bump(state);
        let seeds = &[token_kind.staking_pool_seed(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staking_pool.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.staking_pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount,
        )?;

        // Update state based on token type
        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_sub(amount)
            .ok_or(ErrorCode::Underflow)?;
        if token_kind.is_sol() {
            state.total_staked_sol = state
                .total_staked_sol
                .checked_sub(amount)
                .ok_or(ErrorCode::Underflow)?;
        } else {
            state.total_staked_usdc = state
                .total_staked_usdc
                .checked_sub(amount)
                .ok_or(ErrorCode::Underflow)?;
        }

        emit!(UnstakeEvent {
            user: ctx.accounts.user.key(),
            amount,
        });

        let total_staked = state
            .total_staked_sol
            .checked_add(state.total_staked_usdc)
            .unwrap_or(0);
        msg!(
            "Unstaked {} tokens (type: {}). Total staked: {}",
            amount,
            token_kind.as_u8(),
            total_staked
        );
        Ok(())
    }

    // Yield Farming: Claim rewards
    pub fn claim_rewards(ctx: Context<ClaimRewards>, token_type: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let user_stake = &mut ctx.accounts.user_stake;

        require!(!state.paused, ErrorCode::Paused);
        let token_kind = TokenKind::from_u8(token_type)?;
        require!(
            user_stake.token_type == token_kind.as_u8(),
            ErrorCode::InvalidTokenType
        );

        // Calculate pending rewards
        update_rewards_internal(state, user_stake)?;

        let rewards = user_stake.pending_rewards;
        require!(rewards > 0, ErrorCode::ZeroRewards);

        // Select the correct reward vault based on token type
        let (reward_vault, bump, vault_seed): (&Account<TokenAccount>, u8, &[u8]) =
            if token_kind.is_sol() {
                (
                    &ctx.accounts.reward_vault_sol,
                    token_kind.reward_vault_bump(state),
                    token_kind.reward_vault_seed(),
                )
            } else {
                (
                    &ctx.accounts.reward_vault_usdc,
                    token_kind.reward_vault_bump(state),
                    token_kind.reward_vault_seed(),
                )
            };

        require!(
            reward_vault.amount >= rewards,
            ErrorCode::InsufficientBalance
        );

        // Reset pending rewards first
        user_stake.pending_rewards = 0;
        state.total_rewards_distributed = state
            .total_rewards_distributed
            .checked_add(rewards)
            .ok_or(ErrorCode::Overflow)?;

        //let seeds = &[vault_seed.as_ref(), &[bump]];

        let bump_slice: &[u8] = &[bump];
        let seeds = &[vault_seed.as_ref(), bump_slice];

        // Transfer rewards from appropriate vault to user
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: reward_vault.to_account_info(),
                    to: ctx.accounts.user_reward_token_account.to_account_info(),
                    authority: reward_vault.to_account_info(),
                },
                &[&seeds[..]],
            ),
            rewards,
        )?;
        msg!(
            "Claimed {} rewards for token type {}",
            rewards,
            token_kind.as_u8()
        );

        emit!(ClaimEvent {
            user: ctx.accounts.user.key(),
            amount: rewards,
        });

        Ok(())
    }

    // Staking: Close the UserStake account (only if empty)
    pub fn close_stake_account(_ctx: Context<CloseStakeAccount>, token_type: u8) -> Result<()> {
        let token_kind = TokenKind::from_u8(token_type)?;
        // Constraints in the #[account] macro already ensure this account is empty
        msg!(
            "User stake account closed for token type {}",
            token_kind.as_u8()
        );
        Ok(())
    }

    // Emergency: Unstake without claiming rewards (for crisis situations)
    pub fn emergency_unstake(ctx: Context<EmergencyUnstake>, token_type: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let user_stake = &mut ctx.accounts.user_stake;

        require!(state.paused, ErrorCode::NotInEmergencyMode);

        let token_kind = TokenKind::from_u8(token_type)?;
        require!(user_stake.staked_amount > 0, ErrorCode::InsufficientBalance);
        require!(
            user_stake.token_type == token_kind.as_u8(),
            ErrorCode::InvalidTokenType
        );

        // Update rewards *before* unstaking, but we'll forfeit pending rewards
        update_rewards_internal(state, user_stake)?;

        let amount = user_stake.staked_amount;
        let bump = token_kind.staking_pool_bump(state);
        let seeds = &[token_kind.staking_pool_seed(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staking_pool.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.staking_pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount,
        )?;

        // Forfeit all pending rewards - emergency unstake doesn't get rewards
        let forfeited_rewards = user_stake.pending_rewards;
        user_stake.pending_rewards = 0;

        // Update state based on token type
        user_stake.staked_amount = 0;
        if token_kind.is_sol() {
            state.total_staked_sol = state
                .total_staked_sol
                .checked_sub(amount)
                .ok_or(ErrorCode::Underflow)?;
        } else {
            state.total_staked_usdc = state
                .total_staked_usdc
                .checked_sub(amount)
                .ok_or(ErrorCode::Underflow)?;
        }

        emit!(EmergencyUnstakeEvent {
            user: ctx.accounts.user.key(),
            amount,
        });

        msg!(
            "Emergency unstaked {} tokens (type: {}), forfeited {} rewards",
            amount,
            token_kind.as_u8(),
            forfeited_rewards
        );
        Ok(())
    }

    // Admin: Pause the program
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require_multisig_signer(state, ctx.accounts.admin.key())?;
        if let Some(pending) = &state.pending_action {
            require!(
                pending.action_type == ActionType::Pause,
                ErrorCode::InvalidAction
            );

            // Check approvals
            let approval_count = pending.approvals.iter().filter(|&&x| x).count();
            require!(
                approval_count >= state.required_signatures as usize,
                ErrorCode::InsufficientSignatures
            );
            state.paused = true;
            state.pending_action = None;
        } else {
            return err!(ErrorCode::InvalidAction);
        }
        msg!("Program paused");
        Ok(())
    }

    // Admin: Unpause the program
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require_multisig_signer(state, ctx.accounts.admin.key())?;
        if let Some(pending) = &state.pending_action {
            require!(
                pending.action_type == ActionType::Unpause,
                ErrorCode::InvalidAction
            );

            // Check approvals
            let approval_count = pending.approvals.iter().filter(|&&x| x).count();
            require!(
                approval_count >= state.required_signatures as usize,
                ErrorCode::InsufficientSignatures
            );

            require!(
                Clock::get()?.unix_timestamp >= pending.proposed_at + state.timelock_delay,
                ErrorCode::TimelockNotExpired
            );
            state.paused = false;
            state.pending_action = None;
        } else {
            return err!(ErrorCode::InvalidAction);
        }
        msg!("Program unpaused");
        Ok(())
    }

    // Admin: Propose an action (starts the multisig process)
    pub fn propose_action(
        ctx: Context<ProposeAction>,
        action_type: ActionType,
        data: Vec<u8>,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let signer = ctx.accounts.admin.key();

        require!(
            state.pending_action.is_none(),
            ErrorCode::ProposalAlreadyActive
        );

        let mut approvals = [false; 3];

        // Check main signer
        if signer == state.signer1 {
            approvals[0] = true;
        } else if signer == state.signer2 {
            approvals[1] = true;
        } else if signer == state.signer3 {
            approvals[2] = true;
        } else {
            return err!(ErrorCode::Unauthorized);
        }

        // Check remaining accounts for other signers
        for acc in ctx.remaining_accounts.iter() {
            if acc.is_signer {
                if acc.key() == state.signer1 {
                    approvals[0] = true;
                } else if acc.key() == state.signer2 {
                    approvals[1] = true;
                } else if acc.key() == state.signer3 {
                    approvals[2] = true;
                }
            }
        }

        state.pending_action = Some(PendingAction {
            action_type,
            proposed_at: Clock::get()?.unix_timestamp,
            data,
            approvals,
            created_by: signer,
        });

        msg!("Action proposed by {}. Approvals: {:?}", signer, approvals);
        Ok(())
    }

    // Admin: Approve pending action
    pub fn approve_action(ctx: Context<ApproveAction>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let signer = ctx.accounts.admin.key();

        // Cache signers to avoid borrow checker issues
        let s1 = state.signer1;
        let s2 = state.signer2;
        let s3 = state.signer3;

        require!(state.pending_action.is_some(), ErrorCode::InvalidAction);
        let pending = state.pending_action.as_mut().unwrap();

        if signer == s1 {
            pending.approvals[0] = true;
        } else if signer == s2 {
            pending.approvals[1] = true;
        } else if signer == s3 {
            pending.approvals[2] = true;
        } else {
            return err!(ErrorCode::Unauthorized);
        }

        msg!("Action approved by {}.", signer);
        Ok(())
    }

    // Admin: Cancel pending action to avoid governance gridlock
    pub fn cancel_action(ctx: Context<CancelAction>) -> Result<()> {
        let state = &mut ctx.accounts.state;

        require!(state.pending_action.is_some(), ErrorCode::InvalidAction);
        require_multisig_signer(state, ctx.accounts.admin.key())?;

        state.pending_action = None;
        msg!("Pending action cancelled by {}.", ctx.accounts.admin.key());
        Ok(())
    }

    // Admin: Update reward rate with timelock
    pub fn update_reward_rate(ctx: Context<UpdateRewardRate>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require_multisig_signer(state, ctx.accounts.admin.key())?;
        if let Some(pending) = &state.pending_action {
            require!(
                pending.action_type == ActionType::UpdateRewardRate,
                ErrorCode::InvalidAction
            );

            // Check approvals
            let approval_count = pending.approvals.iter().filter(|&&x| x).count();
            require!(
                approval_count >= state.required_signatures as usize,
                ErrorCode::InsufficientSignatures
            );

            require!(
                Clock::get()?.unix_timestamp >= pending.proposed_at + state.timelock_delay,
                ErrorCode::TimelockNotExpired
            );

            // Extract new_rate from pending action data
            require!(pending.data.len() >= 8, ErrorCode::InvalidAction);
            let new_rate = u64::from_le_bytes(pending.data[0..8].try_into().unwrap());
            require!(new_rate <= MAX_REWARD_RATE, ErrorCode::InvalidAmount);

            // Checkpoint rewards with the old rate before switching to the new rate.
            update_global_rewards(state)?;

            state.reward_rate = new_rate;
            state.pending_action = None;
            msg!("Reward rate updated to {}", new_rate);
        }
        Ok(())
    }

    // Admin: Update the approved flash-loan callback program with timelock
    pub fn update_flash_loan_callback_program(
        ctx: Context<UpdateFlashLoanCallbackProgram>,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require_multisig_signer(state, ctx.accounts.admin.key())?;

        if let Some(pending) = &state.pending_action {
            require!(
                pending.action_type == ActionType::UpdateFlashLoanCallbackProgram,
                ErrorCode::InvalidAction
            );

            let approval_count = pending.approvals.iter().filter(|&&x| x).count();
            require!(
                approval_count >= state.required_signatures as usize,
                ErrorCode::InsufficientSignatures
            );
            require!(
                Clock::get()?.unix_timestamp >= pending.proposed_at + state.timelock_delay,
                ErrorCode::TimelockNotExpired
            );
            require!(pending.data.len() >= 32, ErrorCode::InvalidAction);

            let callback_program = Pubkey::new_from_array(
                pending.data[0..32]
                    .try_into()
                    .map_err(|_| ErrorCode::InvalidAction)?,
            );
            require!(
                callback_program != Pubkey::default(),
                ErrorCode::InvalidCallbackProgram
            );

            state.flash_loan_callback_program = callback_program;
            state.pending_action = None;
            msg!(
                "Flash loan callback program updated to {}",
                callback_program
            );
        } else {
            return err!(ErrorCode::InvalidAction);
        }

        Ok(())
    }

    // AMM: Create a new liquidity pool
    pub fn create_pool(ctx: Context<CreatePool>, fee_basis_points: u16) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.state.authority,
            ErrorCode::Unauthorized
        );

        // FIX: Add reasonable fee range validation (0.01% to 10%)
        // This prevents misconfiguration that could harm users or the protocol
        require!(
            fee_basis_points >= 1 && fee_basis_points <= 1000,
            ErrorCode::InvalidFeeAmount
        );

        // FIX: Prevent same mint (e.g., SOL-SOL pool)
        require!(
            ctx.accounts.token_a_mint.key() != ctx.accounts.token_b_mint.key(),
            ErrorCode::InvalidMintOrder
        );

        // Enforce canonical mint order
        require!(
            ctx.accounts.token_a_mint.key() < ctx.accounts.token_b_mint.key(),
            ErrorCode::InvalidMintOrder
        );

        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.token_a_mint = ctx.accounts.token_a_mint.key();
        pool.token_b_mint = ctx.accounts.token_b_mint.key();
        pool.token_a_account = ctx.accounts.token_a_account.key();
        pool.token_b_account = ctx.accounts.token_b_account.key();
        pool.lp_token_mint = ctx.accounts.lp_token_mint.key();
        pool.fee_basis_points = fee_basis_points;
        pool.k_last = 0;
        pool.flash_loan_fee_basis_points = 30; // Default 0.3%

        emit!(PoolCreated {
            pool: pool.key(),
            token_a: pool.token_a_mint,
            token_b: pool.token_b_mint,
            lp_mint: pool.lp_token_mint,
        });

        msg!(
            "Created new pool for {} and {}",
            pool.token_a_mint,
            pool.token_b_mint
        );
        Ok(())
    }

    /// Flash loan with simple repayment verification (Raydium/Orca style)
    /// Borrows funds, invokes callback, then checks pool balance increased
    /// This is simpler and more secure than escrow-based approaches
    pub fn flash_loan<'info>(
        ctx: Context<'_, '_, '_, 'info, FlashLoan<'info>>,
        amount: u64,
        borrower_program_id: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(
            ctx.accounts.state.flash_loan_callback_program != Pubkey::default(),
            ErrorCode::InvalidCallbackProgram
        );
        require!(
            borrower_program_id == ctx.accounts.state.flash_loan_callback_program,
            ErrorCode::UnapprovedCallbackProgram
        );

        let pool = &ctx.accounts.pool;
        let loan_mint = ctx.accounts.borrower_token_account.mint;

        // Explicit check: which token is being borrowed?
        let pool_vault = if loan_mint == pool.token_a_mint {
            &ctx.accounts.pool_token_a
        } else if loan_mint == pool.token_b_mint {
            &ctx.accounts.pool_token_b
        } else {
            return err!(ErrorCode::InvalidMint);
        };

        // Circuit breaker: Prevent borrowing more than 50% of pool liquidity
        // This protects against cascading liquidations and extreme market manipulation
        let max_flash_loan = pool_vault
            .amount
            .checked_div(2)
            .ok_or(ErrorCode::Overflow)?;
        require!(amount <= max_flash_loan, ErrorCode::FlashLoanTooLarge);

        // Calculate fee (0.3% default)
        let fee = amount
            .checked_mul(pool.flash_loan_fee_basis_points as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_add(9999)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;

        // Snapshot initial reserves and invariant before callback.
        let initial_reserve_a = ctx.accounts.pool_token_a.amount as u128;
        let initial_reserve_b = ctx.accounts.pool_token_b.amount as u128;
        let invariant_before = initial_reserve_a
            .checked_mul(initial_reserve_b)
            .ok_or(ErrorCode::Overflow)?;

        // Required invariant bump from fee payment in the borrowed token.
        let other_reserve = if loan_mint == pool.token_a_mint {
            initial_reserve_b
        } else {
            initial_reserve_a
        };
        let required_invariant_increase = (fee as u128)
            .checked_mul(other_reserve)
            .ok_or(ErrorCode::Overflow)?;
        let min_invariant_after = invariant_before
            .checked_add(required_invariant_increase)
            .ok_or(ErrorCode::Overflow)?;

        // STEP 1: Transfer loan to borrower
        let seeds = &[
            b"pool".as_ref(),
            pool.token_a_mint.as_ref(),
            pool.token_b_mint.as_ref(),
            &[ctx.bumps.pool],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: pool_vault.to_account_info(),
                    to: ctx.accounts.borrower_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        // STEP 2: Build callback data for borrower
        let current_ts = ctx.accounts.clock.unix_timestamp;
        let deadline = current_ts + 60;

        let mut callback_data = Vec::with_capacity(32);
        callback_data.extend_from_slice(&amount.to_le_bytes());
        callback_data.extend_from_slice(&fee.to_le_bytes());
        callback_data.extend_from_slice(&deadline.to_le_bytes());
        callback_data.extend_from_slice(&pool_vault.key().to_bytes()); // Where to repay

        // Build account metas for callback
        let mut callback_accounts: Vec<AccountMeta> = vec![
            AccountMeta::new(ctx.accounts.borrower_token_account.key(), false), // Borrower's token account
            AccountMeta::new(pool_vault.key(), false), // Repayment destination
            AccountMeta::new_readonly(ctx.accounts.borrower.key(), true), // Borrower must sign
        ];

        // Add borrower's custom accounts from remaining_accounts
        callback_accounts.extend(ctx.remaining_accounts.iter().map(|acc| {
            if acc.is_writable {
                AccountMeta::new(acc.key(), acc.is_signer)
            } else {
                AccountMeta::new_readonly(acc.key(), acc.is_signer)
            }
        }));

        // STEP 3: Invoke borrower's callback
        let mut all_accounts = vec![
            ctx.accounts.borrower_token_account.to_account_info(),
            pool_vault.to_account_info(),
            ctx.accounts.borrower.to_account_info(),
        ];
        all_accounts.extend_from_slice(ctx.remaining_accounts);

        invoke(
            &Instruction {
                program_id: borrower_program_id,
                accounts: callback_accounts,
                data: callback_data,
            },
            &all_accounts,
        )?;

        // STEP 4: Verify repayment using constant-product invariant.
        ctx.accounts.pool_token_a.reload()?;
        ctx.accounts.pool_token_b.reload()?;

        let final_reserve_a = ctx.accounts.pool_token_a.amount as u128;
        let final_reserve_b = ctx.accounts.pool_token_b.amount as u128;
        let invariant_after = final_reserve_a
            .checked_mul(final_reserve_b)
            .ok_or(ErrorCode::Overflow)?;

        require!(
            invariant_after >= min_invariant_after,
            ErrorCode::FlashLoanNotRepaid
        );

        msg!(
            "Flash loan success: {} borrowed, {} fee collected, invariant {} -> {}",
            amount,
            fee,
            invariant_before,
            invariant_after
        );
        Ok(())
    }

    // AMM: Add liquidity
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_to_mint: u64,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, ErrorCode::Paused);
        require!(amount_a > 0 && amount_b > 0, ErrorCode::InvalidAmount);

        // Update global rewards before AMM operation
        update_global_rewards(state)?;

        let token_a_mint = ctx.accounts.pool.token_a_mint;
        let token_b_mint = ctx.accounts.pool.token_b_mint;

        let pool = &mut ctx.accounts.pool;
        let pool_token_a_amount = ctx.accounts.pool_token_a.amount;
        let pool_token_b_amount = ctx.accounts.pool_token_b.amount;

        // Check for proportionality if pool is not empty
        if pool.k_last != 0 && pool_token_a_amount > 0 && pool_token_b_amount > 0 {
            let ratio1 = (amount_b as u128)
                .checked_mul(pool_token_a_amount as u128)
                .ok_or(ErrorCode::Overflow)?;
            let ratio2 = (amount_a as u128)
                .checked_mul(pool_token_b_amount as u128)
                .ok_or(ErrorCode::Overflow)?;

            // Allow a tiny 0.1% difference for rounding
            let tolerance = 1000;
            let lower_bound = ratio1
                .checked_mul(tolerance - 1)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(tolerance)
                .ok_or(ErrorCode::Overflow)?;
            let upper_bound = ratio1
                .checked_mul(tolerance + 1)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(tolerance)
                .ok_or(ErrorCode::Overflow)?;

            require!(
                lower_bound <= ratio2 && ratio2 <= upper_bound,
                ErrorCode::NonProportionalLiquidity
            );
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_a.to_account_info(),
                    to: ctx.accounts.pool_token_a.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_a,
        )?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_b.to_account_info(),
                    to: ctx.accounts.pool_token_b.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_b,
        )?;

        let total_supply = ctx.accounts.lp_token_mint.supply;
        let lp_to_mint = if total_supply == 0 {
            // Use proper geometric mean calculation for initial LP tokens
            // This prevents manipulation where first LP gets disproportionate share
            // Following Uniswap V2 standard: sqrt(amount_a * amount_b) - MINIMUM_LIQUIDITY
            let product = (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(ErrorCode::Overflow)?;

            // Integer square root using Newton's method
            // This is deterministic and safe for on-chain computation
            let mut z = product;
            if product > 3 {
                let mut x = product / 2 + 1;
                while x < z {
                    z = x;
                    x = (product / x + x) / 2;
                }
            }

            // Ensure minimum liquidity to prevent dust attacks
            let sqrt_k = z as u64;
            require!(sqrt_k > MINIMUM_LIQUIDITY, ErrorCode::InsufficientLiquidity);

            // Reserve MINIMUM_LIQUIDITY from initial mint calculation.
            // Do not also burn from the user, or it is subtracted twice.
            sqrt_k
                .checked_sub(MINIMUM_LIQUIDITY)
                .ok_or(ErrorCode::InsufficientLiquidity)?
        } else {
            // Mint is proportional to the amount of token A supplied.
            let lp_amount_a = (amount_a as u128)
                .checked_mul(total_supply as u128)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(pool_token_a_amount as u128)
                .ok_or(ErrorCode::Overflow)?;

            let lp_amount_b = (amount_b as u128)
                .checked_mul(total_supply as u128)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(pool_token_b_amount as u128)
                .ok_or(ErrorCode::Overflow)?;

            // Use the smaller of the two amounts to prevent dilution
            lp_amount_a.min(lp_amount_b) as u64
        };

        // Slippage check
        require!(lp_to_mint >= min_lp_to_mint, ErrorCode::Slippage);

        let seeds = &[
            b"pool".as_ref(),
            token_a_mint.as_ref(),
            token_b_mint.as_ref(),
            &[ctx.bumps.pool],
        ];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_token_mint.to_account_info(),
                    to: ctx.accounts.user_lp_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            lp_to_mint,
        )?;

        ctx.accounts.pool_token_a.reload()?;
        ctx.accounts.pool_token_b.reload()?;

        // Update k_last
        let pool = &mut ctx.accounts.pool;
        pool.k_last = (ctx.accounts.pool_token_a.amount as u128)
            .checked_mul(ctx.accounts.pool_token_b.amount as u128)
            .ok_or(ErrorCode::Overflow)?;

        emit!(LiquidityAdded {
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_tokens: lp_to_mint,
        });

        msg!("Added liquidity: {} A, {} B", amount_a, amount_b);
        Ok(())
    }

    // AMM: Remove liquidity
    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_amount_a: u64,
        min_amount_b: u64,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, ErrorCode::Paused);
        require!(lp_amount > 0, ErrorCode::InvalidAmount);

        // Update global rewards before AMM operation
        update_global_rewards(state)?;

        let token_a_mint = ctx.accounts.pool.token_a_mint;
        let token_b_mint = ctx.accounts.pool.token_b_mint;

        let total_supply = ctx.accounts.lp_token_mint.supply;

        // Improved precision for liquidity calculations
        // Use checked math to prevent precision loss and ensure fair withdrawals
        let amount_a = ((lp_amount as u128)
            .checked_mul(ctx.accounts.pool_token_a.amount as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(total_supply as u128)
            .ok_or(ErrorCode::Overflow)?) as u64;

        let amount_b = ((lp_amount as u128)
            .checked_mul(ctx.accounts.pool_token_b.amount as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(total_supply as u128)
            .ok_or(ErrorCode::Overflow)?) as u64;

        // Slippage check - ensure user gets at least minimum amounts
        require!(amount_a >= min_amount_a, ErrorCode::Slippage);
        require!(amount_b >= min_amount_b, ErrorCode::Slippage);

        // Additional safety check: ensure we're not withdrawing more than pool has
        require!(
            amount_a <= ctx.accounts.pool_token_a.amount,
            ErrorCode::InsufficientBalance
        );
        require!(
            amount_b <= ctx.accounts.pool_token_b.amount,
            ErrorCode::InsufficientBalance
        );

        let seeds = &[
            b"pool".as_ref(),
            token_a_mint.as_ref(),
            token_b_mint.as_ref(),
            &[ctx.bumps.pool],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_a.to_account_info(),
                    to: ctx.accounts.user_token_a.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount_a,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_b.to_account_info(),
                    to: ctx.accounts.user_token_b.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount_b,
        )?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_token_mint.to_account_info(),
                    from: ctx.accounts.user_lp_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        ctx.accounts.pool_token_a.reload()?;
        ctx.accounts.pool_token_b.reload()?;

        // Update k_last
        let pool = &mut ctx.accounts.pool;
        pool.k_last = (ctx.accounts.pool_token_a.amount as u128)
            .checked_mul(ctx.accounts.pool_token_b.amount as u128)
            .ok_or(ErrorCode::Overflow)?;

        msg!("Removed liquidity: {} A, {} B", amount_a, amount_b);
        Ok(())
    }

    // Emergency: Remove liquidity without slippage checks (for crisis situations)
    pub fn emergency_remove_liquidity(
        ctx: Context<EmergencyRemoveLiquidity>,
        lp_amount: u64,
    ) -> Result<()> {
        // Emergency withdraw should ONLY work when protocol is paused
        // This prevents abuse to bypass minimum liquidity checks during normal operations
        require!(ctx.accounts.state.paused, ErrorCode::NotInEmergencyMode);
        require!(lp_amount > 0, ErrorCode::InvalidAmount);

        let token_a_mint = ctx.accounts.pool.token_a_mint;
        let token_b_mint = ctx.accounts.pool.token_b_mint;

        let total_supply = ctx.accounts.lp_token_mint.supply;

        // Calculate amounts without minimum checks
        let amount_a = ((lp_amount as u128)
            .checked_mul(ctx.accounts.pool_token_a.amount as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(total_supply as u128)
            .ok_or(ErrorCode::Overflow)?) as u64;

        let amount_b = ((lp_amount as u128)
            .checked_mul(ctx.accounts.pool_token_b.amount as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(total_supply as u128)
            .ok_or(ErrorCode::Overflow)?) as u64;

        // Safety check: ensure we're not withdrawing more than pool has
        require!(
            amount_a <= ctx.accounts.pool_token_a.amount,
            ErrorCode::InsufficientBalance
        );
        require!(
            amount_b <= ctx.accounts.pool_token_b.amount,
            ErrorCode::InsufficientBalance
        );

        let seeds = &[
            b"pool".as_ref(),
            token_a_mint.as_ref(),
            token_b_mint.as_ref(),
            &[ctx.bumps.pool],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_a.to_account_info(),
                    to: ctx.accounts.user_token_a.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount_a,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_b.to_account_info(),
                    to: ctx.accounts.user_token_b.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount_b,
        )?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_token_mint.to_account_info(),
                    from: ctx.accounts.user_lp_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        ctx.accounts.pool_token_a.reload()?;
        ctx.accounts.pool_token_b.reload()?;

        // Update k_last
        let pool = &mut ctx.accounts.pool;
        pool.k_last = (ctx.accounts.pool_token_a.amount as u128)
            .checked_mul(ctx.accounts.pool_token_b.amount as u128)
            .ok_or(ErrorCode::Overflow)?;

        emit!(EmergencyRemoveLiquidityEvent {
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_amount,
        });

        msg!(
            "Emergency removed liquidity: {} A, {} B (slippage protection bypassed)",
            amount_a,
            amount_b
        );
        Ok(())
    }

    // AMM: Swap tokens
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, ErrorCode::Paused);
        require!(amount_in > 0, ErrorCode::InvalidAmount);

        // Update global rewards before AMM operation
        update_global_rewards(state)?;

        msg!("Swap called. Token In: {}", ctx.accounts.token_in.key());
        msg!(
            "Pool Token A: {}, Owner: {}",
            ctx.accounts.pool_token_a.key(),
            ctx.accounts.pool_token_a.owner
        );
        msg!(
            "Pool Token B: {}, Owner: {}",
            ctx.accounts.pool_token_b.key(),
            ctx.accounts.pool_token_b.owner
        );
        msg!("Pool PDA: {}", ctx.accounts.pool.key());

        // Add maximum swap amount check to prevent pool manipulation
        // Limit swaps to 10% of pool reserves to maintain price stability
        let max_swap_a = ctx.accounts.pool_token_a.amount / 10;
        let max_swap_b = ctx.accounts.pool_token_b.amount / 10;

        if ctx.accounts.token_in.key() == ctx.accounts.pool.token_a_mint {
            require!(amount_in <= max_swap_a, ErrorCode::ExcessiveSwapAmount);
        } else {
            require!(amount_in <= max_swap_b, ErrorCode::ExcessiveSwapAmount);
        }

        let amount_out = if ctx.accounts.token_in.key() == ctx.accounts.pool.token_a_mint {
            // Swapping A for B
            let (pool_token_in, pool_token_out) = (
                &mut ctx.accounts.pool_token_a,
                &mut ctx.accounts.pool_token_b,
            );

            // All swap fees stay in the pool for LP providers (standard AMM model)
            let fee = amount_in
                .checked_mul(ctx.accounts.pool.fee_basis_points as u64)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(10000)
                .ok_or(ErrorCode::Overflow)?;
            let amount_in_after_fee = amount_in.checked_sub(fee).ok_or(ErrorCode::Underflow)?;

            let amount_out = (pool_token_out.amount as u128)
                .checked_mul(amount_in_after_fee as u128)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(
                    (pool_token_in.amount as u128)
                        .checked_add(amount_in_after_fee as u128)
                        .ok_or(ErrorCode::Overflow)?,
                )
                .ok_or(ErrorCode::Overflow)? as u64;

            if amount_out < min_amount_out {
                msg!(
                    "Slippage exceeded in swap A for B: expected at least {}, got {}",
                    min_amount_out,
                    amount_out
                );
                return err!(ErrorCode::Slippage);
            }

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_in.to_account_info(),
                        to: pool_token_in.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            // All fees stay in pool for LPs (protocol doesn't take a cut of trading fees)

            let token_a_mint = ctx.accounts.pool.token_a_mint;
            let token_b_mint = ctx.accounts.pool.token_b_mint;
            let seeds = &[
                b"pool".as_ref(),
                token_a_mint.as_ref(),
                token_b_mint.as_ref(),
                &[ctx.bumps.pool],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: pool_token_out.to_account_info(),
                        to: ctx.accounts.user_token_out.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                amount_out,
            )?;
            amount_out
        } else {
            // Swapping B for A
            let (pool_token_in, pool_token_out) = (
                &mut ctx.accounts.pool_token_b,
                &mut ctx.accounts.pool_token_a,
            );

            // All swap fees stay in the pool for LP providers (standard AMM model)
            let fee = amount_in
                .checked_mul(ctx.accounts.pool.fee_basis_points as u64)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(10000)
                .ok_or(ErrorCode::Overflow)?;
            let amount_in_after_fee = amount_in.checked_sub(fee).ok_or(ErrorCode::Underflow)?;

            let amount_out = (pool_token_out.amount as u128)
                .checked_mul(amount_in_after_fee as u128)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(
                    (pool_token_in.amount as u128)
                        .checked_add(amount_in_after_fee as u128)
                        .ok_or(ErrorCode::Overflow)?,
                )
                .ok_or(ErrorCode::Overflow)? as u64;

            if amount_out < min_amount_out {
                msg!(
                    "Slippage exceeded in swap B for A: expected at least {}, got {}",
                    min_amount_out,
                    amount_out
                );
                return err!(ErrorCode::Slippage);
            }

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_in.to_account_info(),
                        to: pool_token_in.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            // All fees stay in pool for LPs (protocol doesn't take a cut of trading fees)

            let token_a_mint = ctx.accounts.pool.token_a_mint;
            let token_b_mint = ctx.accounts.pool.token_b_mint;
            let seeds = &[
                b"pool".as_ref(),
                token_a_mint.as_ref(),
                token_b_mint.as_ref(),
                &[ctx.bumps.pool],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: pool_token_out.to_account_info(),
                        to: ctx.accounts.user_token_out.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                amount_out,
            )?;
            amount_out
        };

        ctx.accounts.pool_token_a.reload()?;
        ctx.accounts.pool_token_b.reload()?;

        let pool = &mut ctx.accounts.pool;
        let invariant_after = (ctx.accounts.pool_token_a.amount as u128)
            .checked_mul(ctx.accounts.pool_token_b.amount as u128)
            .ok_or(ErrorCode::Overflow)?;

        // Check invariant (k_last is only updated on liq add/remove)
        require!(
            invariant_after >= pool.k_last,
            ErrorCode::InvariantViolation
        );

        // Track latest invariant so future operations compare against current pool state.
        pool.k_last = invariant_after;

        emit!(SwapEvent {
            user: ctx.accounts.user.key(),
            token_in: ctx.accounts.token_in.key(),
            token_out: ctx.accounts.token_out.key(),
            amount_in,
            amount_out,
        });

        msg!("Swapped {} for {}", amount_in, amount_out);
        Ok(())
    }

    // A public no-op instruction that just triggers the reward update logic for a user.
    // This is useful for tests to check pending rewards at a specific point in time.
    pub fn update_rewards(ctx: Context<UpdateRewards>, token_type: u8) -> Result<()> {
        let token_kind = TokenKind::from_u8(token_type)?;
        let state = &mut ctx.accounts.state;
        let user_stake = &mut ctx.accounts.user_stake;
        require!(
            user_stake.token_type == token_kind.as_u8(),
            ErrorCode::InvalidTokenType
        );
        update_rewards_internal(state, user_stake)?;
        Ok(())
    }
}

// --- Private Helper Functions ---

fn require_multisig_signer(state: &ProgramState, signer: Pubkey) -> Result<()> {
    require!(
        signer == state.signer1 || signer == state.signer2 || signer == state.signer3,
        ErrorCode::Unauthorized
    );
    Ok(())
}

// Get normalized total staked with proper decimal handling
fn get_normalized_total_staked(state: &Account<ProgramState>) -> Result<u128> {
    // SOL is already 9 decimals
    let normalized_sol = state.total_staked_sol as u128;

    // USDC is 6 decimals, scale up by 10^3
    let usdc_scale_factor = 10u128.pow(NORMALIZED_DECIMALS - 6);
    let normalized_usdc = (state.total_staked_usdc as u128)
        .checked_mul(usdc_scale_factor)
        .ok_or(ErrorCode::Overflow)?;

    // Sum both (equally weighted until oracle integration)
    Ok(normalized_sol
        .checked_add(normalized_usdc)
        .ok_or(ErrorCode::Overflow)?)
}

// Update global reward accumulator (called by all AMM operations)
fn update_global_rewards(state: &mut Account<ProgramState>) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;
    let total_staked = get_normalized_total_staked(state)?;

    if current_time > state.last_update_time && total_staked > 0 {
        let time_elapsed = (current_time - state.last_update_time) as u128;
        let time_elapsed_capped = time_elapsed.min(86400); // Max 24 hours

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

// This is the core logic for the reward accumulator
fn update_rewards_internal(
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

        // 3. Update user's state
        user_stake.pending_rewards = user_stake
            .pending_rewards
            .checked_add(pending)
            .ok_or(ErrorCode::Overflow)?;
    }

    user_stake.reward_per_token_paid = state.reward_per_token_stored;

    Ok(())
}

#[account]
#[derive(Default)]
pub struct ProgramState {
    pub authority: Pubkey,
    pub signer1: Pubkey,
    pub signer2: Pubkey,
    pub signer3: Pubkey,
    pub required_signatures: u8,
    pub total_staked_sol: u64,  // Track SOL stakes separately
    pub total_staked_usdc: u64, // Track USDC stakes separately
    pub paused: bool,
    // Rate of rewards per second (scaled by PRECISION)
    pub reward_rate: u64,
    pub total_rewards_distributed: u64,
    pub staking_pool_sol_bump: u8,  // SOL staking pool
    pub staking_pool_usdc_bump: u8, // USDC staking pool
    pub reward_vault_sol_bump: u8,  // SOL reward vault
    pub reward_vault_usdc_bump: u8, // USDC reward vault
    pub treasury_sol_bump: u8,      // Protocol treasury for SOL
    pub treasury_usdc_bump: u8,     // Protocol treasury for USDC
    // Reward accumulator fields
    pub last_update_time: i64,
    pub reward_per_token_stored: u128,
    // Timelock and upgradeability
    pub timelock_delay: i64, // e.g., 86400 seconds (1 day)
    pub pending_action: Option<PendingAction>,
    pub upgrade_version: u8,
    pub precision: u128,
    pub min_stake_amount: u64,
    // Protocol fees
    pub protocol_fee_basis_points: u16, // e.g., 100 = 1% of fees
    pub flash_loan_callback_program: Pubkey,
}

#[account]
#[derive(Default)]
pub struct UserStake {
    pub user: Pubkey,
    pub staked_amount: u64,
    // Reward accumulator fields
    pub reward_per_token_paid: u128,
    pub pending_rewards: u64,
    pub token_type: u8, // 0 = SOL, 1 = USDC
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
    pub flash_loan_fee_basis_points: u16, // e.g., 30 (0.3%)
}

#[derive(Accounts)]
pub struct InitializeState<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 1024,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProgramState>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeSolAccounts<'info> {
    #[account(
        mut,
        seeds = [b"state"],
        bump,
        has_one = authority
    )]
    pub state: Account<'info, ProgramState>,

    #[account(
        init,
        payer = authority,
        seeds = [b"staking_pool_sol"],
        bump,
        token::mint = sol_mint,
        token::authority = staking_pool_sol
    )]
    pub staking_pool_sol: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"reward_vault_sol"],
        bump,
        token::mint = sol_mint,
        token::authority = reward_vault_sol
    )]
    pub reward_vault_sol: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"protocol_treasury", sol_mint.key().as_ref()],
        bump,
        token::mint = sol_mint,
        token::authority = protocol_treasury_sol
    )]
    pub protocol_treasury_sol: Account<'info, TokenAccount>,

    pub sol_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeUsdcAccounts<'info> {
    #[account(
        mut,
        seeds = [b"state"],
        bump,
        has_one = authority
    )]
    pub state: Account<'info, ProgramState>,

    #[account(
        init,
        payer = authority,
        seeds = [b"staking_pool_usdc"],
        bump,
        token::mint = usdc_mint,
        token::authority = staking_pool_usdc
    )]
    pub staking_pool_usdc: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"reward_vault_usdc"],
        bump,
        token::mint = usdc_mint,
        token::authority = reward_vault_usdc
    )]
    pub reward_vault_usdc: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"protocol_treasury", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = protocol_treasury_usdc
    )]
    pub protocol_treasury_usdc: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(amount: u64, token_type: u8)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [
            if token_type == 0 { b"staking_pool_sol" } else { b"staking_pool_usdc" }
        ],
        bump = if token_type == 0 { state.staking_pool_sol_bump } else { state.staking_pool_usdc_bump }
    )]
    pub staking_pool: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProgramState>,
    #[account(
        init_if_needed,
        payer = user,
        // Space: 8 (disc) + 32 (user) + 8 (staked) + 16 (paid) + 8 (pending) + 1 (token_type) = 73
        space = 8 + 73,
        seeds = [b"user_stake", user.key().as_ref(), &[token_type]],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, token_type: u8)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [
            if token_type == 0 { b"staking_pool_sol" } else { b"staking_pool_usdc" }
        ],
        bump = if token_type == 0 { state.staking_pool_sol_bump } else { state.staking_pool_usdc_bump }
    )]
    pub staking_pool: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), &[token_type]],
        bump,
    )]
    pub user_stake: Account<'info, UserStake>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(token_type: u8)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_reward_token_account.owner == user.key())]
    pub user_reward_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"reward_vault_sol"],
        bump = state.reward_vault_sol_bump
    )]
    pub reward_vault_sol: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"reward_vault_usdc"],
        bump = state.reward_vault_usdc_bump
    )]
    pub reward_vault_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), &[token_type]],
        bump,
    )]
    pub user_stake: Account<'info, UserStake>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(token_type: u8)]
pub struct CloseStakeAccount<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), &[token_type]],
        bump,
        close = user,
        constraint = user_stake.staked_amount == 0 @ ErrorCode::StakeAccountNotEmpty,
        constraint = user_stake.pending_rewards == 0 @ ErrorCode::StakeAccountNotEmpty,
    )]
    pub user_stake: Account<'info, UserStake>,
}

#[derive(Accounts)]
#[instruction(token_type: u8)]
pub struct EmergencyUnstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [
            if token_type == 0 { b"staking_pool_sol" } else { b"staking_pool_usdc" }
        ],
        bump = if token_type == 0 { state.staking_pool_sol_bump } else { state.staking_pool_usdc_bump }
    )]
    pub staking_pool: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), &[token_type]],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, token_type: u8)]
pub struct FundRewardVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = authority_token_account.owner == authority.key(),
        constraint = authority_token_account.mint == stake_mint.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [if token_type == 0 { b"reward_vault_sol" } else { b"reward_vault_usdc" }],
        bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,
    pub stake_mint: Account<'info, Mint>,
    #[account(mut, has_one = authority, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProposeAction<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveAction<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAction<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct FlashLoan<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    /// Borrower's token account that receives the loan
    /// Must match one of the pool's token mints
    #[account(
        mut,
        constraint = borrower_token_account.owner == borrower.key() @ ErrorCode::Unauthorized,
        constraint = borrower_token_account.mint == pool.token_a_mint || borrower_token_account.mint == pool.token_b_mint @ ErrorCode::InvalidMint,
    )]
    pub borrower_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut, constraint = pool_token_a.key() == pool.token_a_account)]
    pub pool_token_a: Account<'info, TokenAccount>,

    #[account(mut, constraint = pool_token_b.key() == pool.token_b_account)]
    pub pool_token_b: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,

    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct UpdateRewardRate<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateFlashLoanCallbackProgram<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 1 + 32 + 32 + 32 + 32 + 32 + 2 + 16 + 2,
        seeds = [b"pool", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        token::mint = token_a_mint,
        token::authority = pool,
        seeds = [b"pool_token_a", pool.key().as_ref()],
        bump
    )]
    pub token_a_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        token::mint = token_b_mint,
        token::authority = pool,
        seeds = [b"pool_token_b", pool.key().as_ref()],
        bump
    )]
    pub token_b_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        mint::decimals = 9,
        mint::authority = pool,
        seeds = [b"lp_token_mint", pool.key().as_ref()],
        bump
    )]
    pub lp_token_mint: Account<'info, Mint>,
    #[account(mut, has_one = authority, seeds = [b"state"], bump)]
    pub state: Account<'info, ProgramState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_a.mint == pool.token_a_mint)]
    pub user_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_b.mint == pool.token_b_mint)]
    pub user_token_b: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_lp_token_account.mint == lp_token_mint.key()
    )]
    pub user_lp_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, constraint = pool_token_a.key() == pool.token_a_account)]
    pub pool_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = pool_token_b.key() == pool.token_b_account)]
    pub pool_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = lp_token_mint.key() == pool.lp_token_mint)]
    pub lp_token_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Box<Account<'info, ProgramState>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_a.mint == pool.token_a_mint)]
    pub user_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_b.mint == pool.token_b_mint)]
    pub user_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_lp_token_account.mint == pool.lp_token_mint)]
    pub user_lp_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, constraint = pool_token_a.key() == pool.token_a_account)]
    pub pool_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = pool_token_b.key() == pool.token_b_account)]
    pub pool_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = lp_token_mint.key() == pool.lp_token_mint)]
    pub lp_token_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Box<Account<'info, ProgramState>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyRemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_a.mint == pool.token_a_mint)]
    pub user_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_b.mint == pool.token_b_mint)]
    pub user_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_lp_token_account.mint == pool.lp_token_mint)]
    pub user_lp_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, constraint = pool_token_a.key() == pool.token_a_account)]
    pub pool_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = pool_token_b.key() == pool.token_b_account)]
    pub pool_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = lp_token_mint.key() == pool.lp_token_mint)]
    pub lp_token_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Box<Account<'info, ProgramState>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = user_token_in.mint == token_in.key())]
    pub user_token_in: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_out.mint == token_out.key())]
    pub user_token_out: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump,
        constraint = (token_in.key() == pool.token_a_mint && token_out.key() == pool.token_b_mint) ||
                     (token_in.key() == pool.token_b_mint && token_out.key() == pool.token_a_mint)
                     @ ErrorCode::InvalidMintOrder
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, constraint = pool_token_a.key() == pool.token_a_account)]
    pub pool_token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = pool_token_b.key() == pool.token_b_account)]
    pub pool_token_b: Box<Account<'info, TokenAccount>>,
    pub token_in: Box<Account<'info, Mint>>,
    pub token_out: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Box<Account<'info, ProgramState>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(token_type: u8)]
pub struct UpdateRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), &[token_type]],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Emergency mode not active (protocol must be paused)")]
    NotInEmergencyMode,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Slippage tolerance exceeded")]
    Slippage,
    #[msg("Non-proportional liquidity")]
    NonProportionalLiquidity,
    #[msg("Invariant violation")]
    InvariantViolation,
    #[msg("Invalid mint order for pool")]
    InvalidMintOrder,
    #[msg("No rewards to claim")]
    ZeroRewards,
    #[msg("Stake account is not empty. Unstake all tokens and claim all rewards first.")]
    StakeAccountNotEmpty,
    #[msg("Insufficient liquidity provided")]
    InsufficientLiquidity,
    #[msg("Insufficient stake amount")]
    InsufficientStake,
    #[msg("Amount below minimum required")]
    InsufficientAmount,
    #[msg("Swap amount too large for pool stability")]
    ExcessiveSwapAmount,
    #[msg("Fee amount out of valid range")]
    InvalidFeeAmount,
    #[msg("Invalid mint for flash loan")]
    InvalidMint,
    #[msg("Insufficient signatures for multi-sig operation")]
    InsufficientSignatures,
    #[msg("Invalid action for timelock")]
    InvalidAction,
    #[msg("Timelock delay not expired")]
    TimelockNotExpired,
    #[msg("Invalid token type. Must be 0 (SOL) or 1 (USDC)")]
    InvalidTokenType,
    #[msg("An active proposal already exists")]
    ProposalAlreadyActive,
    #[msg("Flash loan not repaid in same transaction")]
    FlashLoanNotRepaid,
    #[msg("Flash loan amount exceeds safety limit (max 50% of pool liquidity)")]
    FlashLoanTooLarge,
    #[msg("Invalid flash loan callback program")]
    InvalidCallbackProgram,
    #[msg("Flash loan callback program is not approved")]
    UnapprovedCallbackProgram,
}
