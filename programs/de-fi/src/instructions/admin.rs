use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::{
    update_global_rewards, ActionType, PendingAction, ProgramState, MAX_REWARD_RATE,
    MAX_TIMELOCK_DELAY, MIN_STAKE_AMOUNT, PRECISION,
};

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

fn require_multisig_signer(state: &ProgramState, signer: Pubkey) -> Result<()> {
    require!(
        signer == state.signer1 || signer == state.signer2 || signer == state.signer3,
        ErrorCode::Unauthorized
    );
    Ok(())
}

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

pub fn initialize_sol_accounts(ctx: Context<InitializeSolAccounts>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.staking_pool_sol_bump = ctx.bumps.staking_pool_sol;
    state.reward_vault_sol_bump = ctx.bumps.reward_vault_sol;
    state.treasury_sol_bump = ctx.bumps.protocol_treasury_sol;

    msg!("SOL accounts initialized");
    Ok(())
}

pub fn initialize_usdc_accounts(ctx: Context<InitializeUsdcAccounts>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.staking_pool_usdc_bump = ctx.bumps.staking_pool_usdc;
    state.reward_vault_usdc_bump = ctx.bumps.reward_vault_usdc;
    state.treasury_usdc_bump = ctx.bumps.protocol_treasury_usdc;

    msg!("USDC accounts initialized");
    Ok(())
}

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
    let token_kind = crate::state::TokenKind::from_u8(token_type)?;

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

pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    require_multisig_signer(state, ctx.accounts.admin.key())?;
    if let Some(pending) = &state.pending_action {
        require!(pending.action_type == ActionType::Pause, ErrorCode::InvalidAction);

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

pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    require_multisig_signer(state, ctx.accounts.admin.key())?;
    if let Some(pending) = &state.pending_action {
        require!(pending.action_type == ActionType::Unpause, ErrorCode::InvalidAction);

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

    if signer == state.signer1 {
        approvals[0] = true;
    } else if signer == state.signer2 {
        approvals[1] = true;
    } else if signer == state.signer3 {
        approvals[2] = true;
    } else {
        return err!(ErrorCode::Unauthorized);
    }

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

pub fn approve_action(ctx: Context<ApproveAction>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    let signer = ctx.accounts.admin.key();

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

pub fn cancel_action(ctx: Context<CancelAction>) -> Result<()> {
    let state = &mut ctx.accounts.state;

    require!(state.pending_action.is_some(), ErrorCode::InvalidAction);
    require_multisig_signer(state, ctx.accounts.admin.key())?;

    state.pending_action = None;
    msg!("Pending action cancelled by {}.", ctx.accounts.admin.key());
    Ok(())
}

pub fn update_reward_rate(ctx: Context<UpdateRewardRate>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    require_multisig_signer(state, ctx.accounts.admin.key())?;
    if let Some(pending) = &state.pending_action {
        require!(
            pending.action_type == ActionType::UpdateRewardRate,
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

        require!(pending.data.len() >= 8, ErrorCode::InvalidAction);
        let new_rate = u64::from_le_bytes(pending.data[0..8].try_into().unwrap());
        require!(new_rate <= MAX_REWARD_RATE, ErrorCode::InvalidAmount);

        update_global_rewards(state)?;

        state.reward_rate = new_rate;
        state.pending_action = None;
        msg!("Reward rate updated to {}", new_rate);
    }
    Ok(())
}

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