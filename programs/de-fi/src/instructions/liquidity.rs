use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{update_global_rewards, Pool, ProgramState, MINIMUM_LIQUIDITY};

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
pub struct FlashLoan<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

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

pub fn create_pool(ctx: Context<CreatePool>, fee_basis_points: u16) -> Result<()> {
    require!(!ctx.accounts.state.paused, ErrorCode::Paused);
    require!(
        ctx.accounts.authority.key() == ctx.accounts.state.authority,
        ErrorCode::Unauthorized
    );

    require!(
        fee_basis_points >= 1 && fee_basis_points <= 1000,
        ErrorCode::InvalidFeeAmount
    );

    require!(
        ctx.accounts.token_a_mint.key() != ctx.accounts.token_b_mint.key(),
        ErrorCode::InvalidMintOrder
    );

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
    pool.flash_loan_fee_basis_points = 30;

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

    let pool_vault = if loan_mint == pool.token_a_mint {
        &ctx.accounts.pool_token_a
    } else if loan_mint == pool.token_b_mint {
        &ctx.accounts.pool_token_b
    } else {
        return err!(ErrorCode::InvalidMint);
    };

    let max_flash_loan = pool_vault
        .amount
        .checked_div(2)
        .ok_or(ErrorCode::Overflow)?;
    require!(amount <= max_flash_loan, ErrorCode::FlashLoanTooLarge);

    let fee = amount
        .checked_mul(pool.flash_loan_fee_basis_points as u64)
        .ok_or(ErrorCode::Overflow)?
        .checked_add(9999)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(10000)
        .ok_or(ErrorCode::Overflow)?;

    let initial_reserve_a = ctx.accounts.pool_token_a.amount as u128;
    let initial_reserve_b = ctx.accounts.pool_token_b.amount as u128;
    let invariant_before = initial_reserve_a
        .checked_mul(initial_reserve_b)
        .ok_or(ErrorCode::Overflow)?;

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

    let current_ts = ctx.accounts.clock.unix_timestamp;
    let deadline = current_ts + 60;

    let mut callback_data = Vec::with_capacity(32);
    callback_data.extend_from_slice(&amount.to_le_bytes());
    callback_data.extend_from_slice(&fee.to_le_bytes());
    callback_data.extend_from_slice(&deadline.to_le_bytes());
    callback_data.extend_from_slice(&pool_vault.key().to_bytes());

    let mut callback_accounts: Vec<AccountMeta> = vec![
        AccountMeta::new(ctx.accounts.borrower_token_account.key(), false),
        AccountMeta::new(pool_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.borrower.key(), true),
    ];

    callback_accounts.extend(ctx.remaining_accounts.iter().map(|acc| {
        if acc.is_writable {
            AccountMeta::new(acc.key(), acc.is_signer)
        } else {
            AccountMeta::new_readonly(acc.key(), acc.is_signer)
        }
    }));

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

    ctx.accounts.pool_token_a.reload()?
    ;
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

pub fn add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
    min_lp_to_mint: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.state;
    require!(!state.paused, ErrorCode::Paused);
    require!(amount_a > 0 && amount_b > 0, ErrorCode::InvalidAmount);

    update_global_rewards(state)?;

    let token_a_mint = ctx.accounts.pool.token_a_mint;
    let token_b_mint = ctx.accounts.pool.token_b_mint;

    let pool = &mut ctx.accounts.pool;
    let pool_token_a_amount = ctx.accounts.pool_token_a.amount;
    let pool_token_b_amount = ctx.accounts.pool_token_b.amount;

    if pool.k_last != 0 && pool_token_a_amount > 0 && pool_token_b_amount > 0 {
        let ratio1 = (amount_b as u128)
            .checked_mul(pool_token_a_amount as u128)
            .ok_or(ErrorCode::Overflow)?;
        let ratio2 = (amount_a as u128)
            .checked_mul(pool_token_b_amount as u128)
            .ok_or(ErrorCode::Overflow)?;

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
        let product = (amount_a as u128)
            .checked_mul(amount_b as u128)
            .ok_or(ErrorCode::Overflow)?;

        let mut z = product;
        if product > 3 {
            let mut x = product / 2 + 1;
            while x < z {
                z = x;
                x = (product / x + x) / 2;
            }
        }

        let sqrt_k = z as u64;
        require!(sqrt_k > MINIMUM_LIQUIDITY, ErrorCode::InsufficientLiquidity);

        sqrt_k
            .checked_sub(MINIMUM_LIQUIDITY)
            .ok_or(ErrorCode::InsufficientLiquidity)?
    } else {
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

        lp_amount_a.min(lp_amount_b) as u64
    };

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

pub fn remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    lp_amount: u64,
    min_amount_a: u64,
    min_amount_b: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.state;
    require!(!state.paused, ErrorCode::Paused);
    require!(lp_amount > 0, ErrorCode::InvalidAmount);

    update_global_rewards(state)?;

    let token_a_mint = ctx.accounts.pool.token_a_mint;
    let token_b_mint = ctx.accounts.pool.token_b_mint;

    let total_supply = ctx.accounts.lp_token_mint.supply;

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

    require!(amount_a >= min_amount_a, ErrorCode::Slippage);
    require!(amount_b >= min_amount_b, ErrorCode::Slippage);

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

    let pool = &mut ctx.accounts.pool;
    pool.k_last = (ctx.accounts.pool_token_a.amount as u128)
        .checked_mul(ctx.accounts.pool_token_b.amount as u128)
        .ok_or(ErrorCode::Overflow)?;

    msg!("Removed liquidity: {} A, {} B", amount_a, amount_b);
    Ok(())
}

pub fn emergency_remove_liquidity(
    ctx: Context<EmergencyRemoveLiquidity>,
    lp_amount: u64,
) -> Result<()> {
    require!(ctx.accounts.state.paused, ErrorCode::NotInEmergencyMode);
    require!(lp_amount > 0, ErrorCode::InvalidAmount);

    let token_a_mint = ctx.accounts.pool.token_a_mint;
    let token_b_mint = ctx.accounts.pool.token_b_mint;

    let total_supply = ctx.accounts.lp_token_mint.supply;

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

pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64) -> Result<()> {
    let state = &mut ctx.accounts.state;
    require!(!state.paused, ErrorCode::Paused);
    require!(amount_in > 0, ErrorCode::InvalidAmount);

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

    let max_swap_a = ctx.accounts.pool_token_a.amount / 10;
    let max_swap_b = ctx.accounts.pool_token_b.amount / 10;

    if ctx.accounts.token_in.key() == ctx.accounts.pool.token_a_mint {
        require!(amount_in <= max_swap_a, ErrorCode::ExcessiveSwapAmount);
    } else {
        require!(amount_in <= max_swap_b, ErrorCode::ExcessiveSwapAmount);
    }

    let amount_out = if ctx.accounts.token_in.key() == ctx.accounts.pool.token_a_mint {
        let (pool_token_in, pool_token_out) = (
            &mut ctx.accounts.pool_token_a,
            &mut ctx.accounts.pool_token_b,
        );

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
        let (pool_token_in, pool_token_out) = (
            &mut ctx.accounts.pool_token_b,
            &mut ctx.accounts.pool_token_a,
        );

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

    require!(invariant_after >= pool.k_last, ErrorCode::InvariantViolation);
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