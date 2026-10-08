import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID as PID_STR } from "@/providers/solana-provider";

const PROGRAM_ID = new PublicKey(PID_STR);

export function getStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
}

export function getUserStakePda(
  user: PublicKey,
  tokenType: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_stake"), user.toBuffer(), Buffer.from([tokenType])],
    PROGRAM_ID
  );
}

export function getStakingPoolPda(tokenType: number): [PublicKey, number] {
  const seed =
    tokenType === 0
      ? Buffer.from("staking_pool_sol")
      : Buffer.from("staking_pool_usdc");
  return PublicKey.findProgramAddressSync([seed], PROGRAM_ID);
}

export function getRewardVaultPda(tokenType: number): [PublicKey, number] {
  const seed =
    tokenType === 0
      ? Buffer.from("reward_vault_sol")
      : Buffer.from("reward_vault_usdc");
  return PublicKey.findProgramAddressSync([seed], PROGRAM_ID);
}

export function getTreasuryPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_treasury"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function sortMintPair(
  a: PublicKey,
  b: PublicKey
): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

/** Pool PDA: seeds = [b"pool", token_a_mint, token_b_mint] */
export function getPoolPda(
  tokenAMint: PublicKey,
  tokenBMint: PublicKey
): [PublicKey, number] {
  const [a, b] = sortMintPair(tokenAMint, tokenBMint);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), a.toBuffer(), b.toBuffer()],
    PROGRAM_ID
  );
}

/** Pool token A/B account PDAs (derived by the program inside create_pool) */
export function getPoolTokenPda(
  pool: PublicKey,
  label: "token_a" | "token_b"
): [PublicKey, number] {
  const seed =
    label === "token_a"
      ? Buffer.from("pool_token_a")
      : Buffer.from("pool_token_b");
  return PublicKey.findProgramAddressSync([seed, pool.toBuffer()], PROGRAM_ID);
}

/** LP token mint PDA */
export function getPoolLpMintPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_token_mint"), pool.toBuffer()],
    PROGRAM_ID
  );
}

/** LP minimum-liquidity lock account PDA (permanently locked LP tokens) */
export function getPoolLpLockAccountPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_lock_account"), pool.toBuffer()],
    PROGRAM_ID
  );
}
