"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getStatePda } from "@/lib/pda";

export function useInitializeState(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (
      s1: PublicKey,
      s2: PublicKey,
      s3: PublicKey,
      timelock: BN
    ): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const [sp] = getStatePda();
      return program.methods
        .initializeState(s1, s2, s3, timelock)
        .accounts({
          state: sp,
          authority: pk,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    },
    [program, provider, pk]
  );
}

export function usePropose(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (actionType: Record<string, unknown>, data: Buffer): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const [sp] = getStatePda();
      return program.methods
        .proposeAction(actionType, data)
        .accounts({ state: sp, admin: pk })
        .rpc();
    },
    [program, provider, pk]
  );
}

export function useApprove(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(async (): Promise<string> => {
    if (!program || !provider || !pk) throw new Error("Wallet not connected");
    const [sp] = getStatePda();
    return program.methods
      .approveAction()
      .accounts({ state: sp, admin: pk })
      .rpc();
  }, [program, provider, pk]);
}

export function useCancel(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(async (): Promise<string> => {
    if (!program || !provider || !pk) throw new Error("Wallet not connected");
    const [sp] = getStatePda();
    return program.methods
      .cancelAction()
      .accounts({ state: sp, admin: pk })
      .rpc();
  }, [program, provider, pk]);
}

export function useExecute(program: any, provider: any) {
  const { publicKey: pk } = useWallet();
  return useCallback(
    async (method: string): Promise<string> => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const [sp] = getStatePda();
      const m = (program as any).methods[method]();
      return m.accounts({ state: sp, admin: pk }).rpc();
    },
    [program, provider, pk]
  );
}