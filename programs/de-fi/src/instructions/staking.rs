use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{update_rewards_internal, ProgramState, TokenKind, UserStake};

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

    if amount < state.min_stake_amount {
        msg!(
            "Stake amount {} below minimum required {}",
            amount,
            state.min_stake_amount
        );
        return err!(ErrorCode::InsufficientAmount);
    }

    update_rewards_internal(state, user_stake)?;

    if user_stake.staked_amount == 0 {
        user_stake.user = ctx.accounts.user.key();
        user_stake.token_type = token_kind.as_u8();
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

pub fn claim_rewards(ctx: Context<ClaimRewards>, token_type: u8) -> Result<()> {
    let state = &mut ctx.accounts.state;
    let user_stake = &mut ctx.accounts.user_stake;

    require!(!state.paused, ErrorCode::Paused);
    let token_kind = TokenKind::from_u8(token_type)?;
    require!(
        user_stake.token_type == token_kind.as_u8(),
        ErrorCode::InvalidTokenType
    );

    update_rewards_internal(state, user_stake)?;

    let rewards = user_stake.pending_rewards;
    require!(rewards > 0, ErrorCode::ZeroRewards);

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

    user_stake.pending_rewards = 0;
    state.total_rewards_distributed = state
        .total_rewards_distributed
        .checked_add(rewards)
        .ok_or(ErrorCode::Overflow)?;

    let bump_slice: &[u8] = &[bump];
    let seeds = &[vault_seed.as_ref(), bump_slice];

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

pub fn close_stake_account(_ctx: Context<CloseStakeAccount>, token_type: u8) -> Result<()> {
    let token_kind = TokenKind::from_u8(token_type)?;
    msg!(
        "User stake account closed for token type {}",
        token_kind.as_u8()
    );
    Ok(())
}

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

    let forfeited_rewards = user_stake.pending_rewards;
    user_stake.pending_rewards = 0;

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