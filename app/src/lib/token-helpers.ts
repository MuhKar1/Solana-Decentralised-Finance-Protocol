"use client";

import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

/** Ensure the owner's Associated Token Account for `mint` exists. Returns its address. */
export async function ensureAta(
  provider: any,
  owner: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const conn = provider.connection;
  const info = await conn.getAccountInfo(ata);
  if (!info) {
    const { blockhash } = await conn.getLatestBlockhash();
    const ix = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    await provider.sendAndConfirm(tx, []);
  }
  return ata;
}

/** Ensure a WSOL ATA is funded with at least `lamports` wrapped SOL. */
export async function wrapSolIfNeeded(
  provider: any,
  owner: PublicKey,
  ata: PublicKey,
  lamports: number
): Promise<void> {
  const conn = provider.connection;
  const info = await conn.getAccountInfo(ata);
  const bal =
    info && info.data.length >= 72
      ? new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(
          0,
          true
        )
      : BigInt(0);
  if (bal < BigInt(lamports)) {
    const need = BigInt(lamports) - bal;
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction()
      .add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: ata,
          lamports: Number(need),
        })
      )
      .add(createSyncNativeInstruction(ata));
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    await provider.sendAndConfirm(tx, []);
  }
}