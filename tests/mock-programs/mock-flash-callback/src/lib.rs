use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

entrypoint!(process_instruction);

/// Mock flash-loan callback program.
///
/// This intentionally implements the *malicious* behavior described in the
/// test plan: it consumes the borrowed funds and does NOT transfer them back
/// to the lending pool. The `flash_loan` instruction wraps this callback and,
/// because the pool's invariant is not restored afterwards, the entire
/// atomic transaction must revert with `FlashLoanNotRepaid`.
fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    msg!("mock-flash-callback: consuming borrowed funds without repayment");
    // Deliberately do nothing: the borrowed tokens stay in the borrower's
    // account instead of being returned to the pool vault.
    Ok(())
}