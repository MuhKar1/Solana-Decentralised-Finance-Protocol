const FRIENDLY_ERRORS: Record<number, string> = {
  0xbc4:
    "Account not initialized. The program state hasn't been set up yet. An admin must call initialize_state first.",
  6000: "Math overflow.",
  6001: "Math underflow.",
  6002: "Unauthorized. Your wallet is not authorized for this action.",
  6003: "Program is paused.",
  6004: "Not in emergency mode.",
  6005: "Invalid amount.",
  6006: "Insufficient balance.",
  6007: "Slippage tolerance exceeded.",
  6008: "Non-proportional liquidity. Token A and B amounts must match the pool ratio.",
  6009: "Invariant violation.",
  6010: "Invalid mint order for pool.",
  6011: "No rewards to claim.",
  6012: "Stake account not empty.",
  6013: "Insufficient liquidity.",
  6014: "Insufficient stake amount.",
  6015: "Amount below minimum.",
  6016: "Swap amount too large for pool stability.",
  6017: "Fee out of valid range.",
  6018: "Invalid mint.",
  6019: "Insufficient signatures for multi-sig.",
  6020: "Invalid action for timelock.",
  6021: "Timelock delay not expired.",
  6022: "Invalid token type. Must be 0 (SOL) or 1 (USDC).",
  6023: "A proposal is already active.",
  6024: "Flash loan not repaid.",
  6025: "Flash loan too large (max 50% of pool).",
  6026: "Invalid callback program.",
  6027: "Callback program not approved.",
  6028: "Invalid multisig signer — the zero (empty) public key is not allowed.",
  6029: "Duplicate multisig signer — all three signers must be unique.",
};

/** Translate an Anchor/program error into a human-readable message. */
export function parseErrorMessage(err: unknown): string {
  if (!err) return "Unknown error.";
  if (typeof err === "string") return err;
  const e = err as Record<string, unknown>;

  if (e.logs && Array.isArray(e.logs)) {
    const logs = e.logs as string[];
    for (const log of logs) {
      if (log.includes("Error Message:")) {
        const m = log.match(/Error Message:\s*(.+?)(?:\.?\s*Program|$)/);
        if (m) return m[1].trim();
      }
      if (log.includes("Error Code:")) {
        const c = log.match(/Error Code:\s*(.+?)(?:\.|$)/);
        if (c) {
          const code = c[1].trim();
          if (code === "AccountNotInitialized") return FRIENDLY_ERRORS[0xbc4];
          if (code === "ConstraintHasOne")
            return "Not authorized — this wallet is not the registered authority.";
          if (code === "ConstraintSeeds")
            return "Account address mismatch — PDA derivation may be wrong.";
          if (code === "ConstraintSigner")
            return "Missing signer — approve the transaction in your wallet.";
          if (code === "AccountOwnedByWrongProgram")
            return "Account owned by wrong program — may not be initialized.";
          return code;
        }
      }
      if (log.includes("custom program error:")) {
        const m = log.match(/custom program error:\s*(0x[0-9a-fA-F]+)/);
        if (m) {
          const code = parseInt(m[1], 16);
          return FRIENDLY_ERRORS[code] || `Program error ${m[1]}.`;
        }
      }
    }
    const last = logs.slice(-3).join(" → ");
    if (last) return `Transaction reverted. Logs: ${last.slice(0, 200)}`;
  }

  if (e.message && typeof e.message === "string") {
    const msg = e.message as string;
    if (msg.includes("User rejected"))
      return "Cancelled — you declined in your wallet.";
    if (msg.includes("Blockhash not found"))
      return "Network delay — blockhash expired before signing. The network is busy or the wallet took too long. Please try again.";
    if (msg.includes("block height exceeded"))
      return "Transaction expired — the network advanced while waiting for your signature. Please try again.";
    if (msg.includes("SendTransactionError"))
      return "Transaction simulation failed. This usually means one of the accounts isn't set up yet (e.g., pool not created, token account missing). Try again.";
    if (msg.includes("insufficient lamports"))
      return "Insufficient SOL in your wallet. Get devnet SOL from faucet.solana.com. Note: funding the SOL vault requires wrapping SOL to WSOL first — make sure you have enough SOL.";
    if (msg.includes("0x1"))
      return "Insufficient funds. For SOL vault: you need enough native SOL + the WSOL token account must be funded. For USDC vault: you need USDC tokens in your wallet.";
    if (msg.includes("insufficient funds"))
      return "Insufficient token balance in your wallet or token account.";
    if (msg.includes("Attempt to debit an account but found no record"))
      return "Token account not found. Create an ATA first.";
    if (msg.includes("Attempt to load a program that does not exist"))
      return "Program not on-chain. Is it deployed to devnet?";
    if (msg.includes("Simulation failed"))
      return "Transaction reverted during simulation. Common causes: pool not created, account not initialized, or insufficient balance. Check the Pool tab to verify pool exists.";
    return msg.slice(0, 300);
  }
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof (obj as any).getLogs === "function") {
      try {
        const logs = (obj as any).getLogs() as string[];
        if (logs && logs.length) {
          const last = logs.slice(-5).join(" → ");
          return `Simulation failed. Logs: ${last.slice(0, 200)}`;
        }
      } catch {}
    }
    if (obj.message && typeof obj.message === "string") {
      return (obj.message as string).slice(0, 300);
    }
  }
  return "Unexpected error. Please try again or check browser console for details.";
}
