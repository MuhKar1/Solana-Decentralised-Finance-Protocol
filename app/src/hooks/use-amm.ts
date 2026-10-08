"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getStatePda,
  getPoolPda,
  sortMintPair,
  getPoolTokenPda,
  getPoolLpMintPda,
  getPoolLpLockAccountPda,
} from "@/lib/pda";
import { ensureAta, wrapSolIfNeeded } from "@/lib/token-helpers";
import {
  PYTH_SOL_FEED_PUBKEY,
  PYTH_USDC_FEED_PUBKEY,
  feedForMint,
} from "@/lib/oracle";

export function useSwap(program: any, provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (amountIn: BN, minAmountOut: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const [tokenA, tokenB] = sortMintPair(wsol, usdcMint);
      const userInAta = await ensureAta(provider, pk, wsol);
      await wrapSolIfNeeded(provider, pk, userInAta, amountIn.toNumber());
      const userOutAta = await ensureAta(provider, pk, usdcMint);

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(tokenA, tokenB);
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
          pythPriceA: PYTH_SOL_FEED_PUBKEY,
          pythPriceB: PYTH_USDC_FEED_PUBKEY,
        })
        .rpc();
    },
    [program, provider, pk, usdcMint]
  );
}

export function useAddLiquidity(
  program: any,
  provider: any,
  usdcMint: PublicKey
) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (amountA: BN, amountB: BN, minLp: BN): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const [tokenA, tokenB] = sortMintPair(wsol, usdcMint);
      const userSolAta = await ensureAta(provider, pk, wsol);
      await wrapSolIfNeeded(provider, pk, userSolAta, amountA.toNumber());
      const userUsdcAta = await ensureAta(provider, pk, usdcMint);
      const wsolIsTokenA = tokenA.equals(wsol);
      const userAtaA = wsolIsTokenA ? userSolAta : userUsdcAta;
      const userAtaB = wsolIsTokenA ? userUsdcAta : userSolAta;
      const programAmountA = wsolIsTokenA ? amountA : amountB;
      const programAmountB = wsolIsTokenA ? amountB : amountA;

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(tokenA, tokenB);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const [lpLockAccount] = getPoolLpLockAccountPda(poolPda);
      const userLpAta = await ensureAta(provider, pk, lpMint);

      return program.methods
        .addLiquidity(programAmountA, programAmountB, minLp)
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
      const [tokenA, tokenB] = sortMintPair(wsol, usdcMint);
      const userSolAta = await ensureAta(provider, pk, wsol);
      const userUsdcAta = await ensureAta(provider, pk, usdcMint);
      const wsolIsTokenA = tokenA.equals(wsol);
      const userAtaA = wsolIsTokenA ? userSolAta : userUsdcAta;
      const userAtaB = wsolIsTokenA ? userUsdcAta : userSolAta;
      const programMinA = wsolIsTokenA ? minA : minB;
      const programMinB = wsolIsTokenA ? minB : minA;

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(tokenA, tokenB);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const userLpAta = await ensureAta(provider, pk, lpMint);

      return program.methods
        .removeLiquidity(lpAmount, programMinA, programMinB)
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

export function useCreatePool(
  program: any,
  provider: any,
  usdcMint: PublicKey
) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (
      feeBasisPoints: number,
      pythFeedA: PublicKey = PYTH_SOL_FEED_PUBKEY,
      pythFeedB: PublicKey = PYTH_USDC_FEED_PUBKEY
    ): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const wsol = new PublicKey("So11111111111111111111111111111111111111112");
      const [tokenA, tokenB] = sortMintPair(wsol, usdcMint);
      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(tokenA, tokenB);
      const [tokenAAccount] = getPoolTokenPda(poolPda, "token_a");
      const [tokenBAccount] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const [lpLockAccount] = getPoolLpLockAccountPda(poolPda);
      return program.methods
        .createPool(
          feeBasisPoints,
          feedForMint(tokenA, usdcMint, pythFeedA, pythFeedB),
          feedForMint(tokenB, usdcMint, pythFeedA, pythFeedB)
        )
        .accounts({
          pool: poolPda,
          tokenAMint: tokenA,
          tokenBMint: tokenB,
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
