"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getStatePda,
  getUserStakePda,
  getStakingPoolPda,
  getRewardVaultPda,
} from "@/lib/pda";
import type { TokenType } from "@/lib/constants";
import { ensureAta, wrapSolIfNeeded } from "@/lib/token-helpers";

function tokenMintFor(tt: TokenType, usdcMint: PublicKey): PublicKey {
  // Native SOL stake uses WSOL; USDC stake uses the protocol's USDC mint.
  if (tt === 0) {
    return new PublicKey("So11111111111111111111111111111111111111112");
  }
  return usdcMint;
}

export function useStake(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (tokenType: TokenType, amountRaw: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const mint = tokenMintFor(tokenType, usdcMint);
      const ata = await ensureAta(provider, pk, mint);
      if (tokenType === 0) {
        await wrapSolIfNeeded(provider, pk, ata, amountRaw.toNumber());
      }
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tokenType);
      const [stp] = getStakingPoolPda(tokenType);
      return program.methods
        .stake(amountRaw, tokenType)
        .accounts({
          user: pk,
          userTokenAccount: ata,
          stakingPool: stp,
          state: sp,
          userStake: usp,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useUnstake(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (tokenType: TokenType, amountRaw: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const mint = tokenMintFor(tokenType, usdcMint);
      const ata = await ensureAta(provider, pk, mint);
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tokenType);
      const [stp] = getStakingPoolPda(tokenType);
      return program.methods
        .unstake(amountRaw, tokenType)
        .accounts({
          user: pk,
          userTokenAccount: ata,
          stakingPool: stp,
          state: sp,
          userStake: usp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useEmergencyUnstake(
  program: any,
  provider: any,
  usdcMint: PublicKey
) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (tokenType: TokenType): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const mint = tokenMintFor(tokenType, usdcMint);
      const ata = await ensureAta(provider, pk, mint);
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tokenType);
      const [stp] = getStakingPoolPda(tokenType);
      return program.methods
        .emergencyUnstake(tokenType)
        .accounts({
          user: pk,
          userTokenAccount: ata,
          stakingPool: stp,
          state: sp,
          userStake: usp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useClaim(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (tokenType: TokenType): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const mint = tokenMintFor(tokenType, usdcMint);
      const ata = await ensureAta(provider, pk, mint);
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tokenType);
      const [rvs] = getRewardVaultPda(0);
      const [rvu] = getRewardVaultPda(1);
      return program.methods
        .claimRewards(tokenType)
        .accounts({
          user: pk,
          userRewardTokenAccount: ata,
          rewardVaultSol: rvs,
          rewardVaultUsdc: rvu,
          state: sp,
          userStake: usp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useUpdateRewards(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (tokenType: TokenType): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tokenType);
      return program.methods
        .updateRewards(tokenType)
        .accounts({ user: pk, state: sp, userStake: usp })
        .rpc();
    },
    [program, provider, pk]
  );
}

export function useCloseStakeAccount(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (tokenType: TokenType): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const [usp] = getUserStakePda(pk, tokenType);
      return program.methods
        .closeStakeAccount(tokenType)
        .accounts({ user: pk, userStake: usp })
        .rpc();
    },
    [program, provider, pk]
  );
}