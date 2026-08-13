"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getStatePda,
  getPoolPda,
  getPoolTokenPda,
  getPoolLpMintPda,
  getPoolLpLockAccountPda,
} from "@/lib/pda";
import { ensureAta, wrapSolIfNeeded } from "@/lib/token-helpers";

export function useSwap(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (amountIn: BN, minAmountOut: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const userInAta = await ensureAta(provider, pk, wsol);
      await wrapSolIfNeeded(provider, pk, userInAta, amountIn.toNumber());
      const userOutAta = await ensureAta(provider, pk, usdcMint);

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(wsol, usdcMint);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");

      return program.methods
        .swap(amountIn, minAmountOut)
        .accounts({
          user: pk,
          userTokenIn: userInAta,
          userTokenOut: userOutAta,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          tokenIn: wsol,
          tokenOut: usdcMint,
          state: sp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useAddLiquidity(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (amountA: BN, amountB: BN, minLp: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const userAtaA = await ensureAta(provider, pk, wsol);
      await wrapSolIfNeeded(provider, pk, userAtaA, amountA.toNumber());
      const userAtaB = await ensureAta(provider, pk, usdcMint);

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(wsol, usdcMint);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const [lpLockAccount] = getPoolLpLockAccountPda(poolPda);
      const userLpAta = await ensureAta(provider, pk, lpMint);

      return program.methods
        .addLiquidity(amountA, amountB, minLp)
        .accounts({
          user: pk,
          userTokenA: userAtaA,
          userTokenB: userAtaB,
          userLpTokenAccount: userLpAta,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          lpTokenMint: lpMint,
          lpLockAccount,
          state: sp,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useRemoveLiquidity(
  program: any,
  provider: any,
  usdcMint: PublicKey
) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (lpAmount: BN, minA: BN, minB: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const userAtaA = await ensureAta(provider, pk, wsol);
      const userAtaB = await ensureAta(provider, pk, usdcMint);

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(wsol, usdcMint);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const userLpAta = await ensureAta(provider, pk, lpMint);

      return program.methods
        .removeLiquidity(lpAmount, minA, minB)
        .accounts({
          user: pk,
          userTokenA: userAtaA,
          userTokenB: userAtaB,
          userLpTokenAccount: userLpAta,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          lpTokenMint: lpMint,
          state: sp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useCreatePool(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (feeBasisPoints: number): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(wsol, usdcMint);
      const [tokenAAccount] = getPoolTokenPda(poolPda, "token_a");
      const [tokenBAccount] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const [lpLockAccount] = getPoolLpLockAccountPda(poolPda);
      return program.methods
        .createPool(feeBasisPoints)
        .accounts({
          pool: poolPda,
          tokenAMint: wsol,
          tokenBMint: usdcMint,
          tokenAAccount,
          tokenBAccount,
          lpTokenMint: lpMint,
          lpLockAccount,
          state: sp,
          authority: pk,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}