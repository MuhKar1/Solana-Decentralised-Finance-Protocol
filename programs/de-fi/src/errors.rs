use anchor_lang::prelude::*;

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