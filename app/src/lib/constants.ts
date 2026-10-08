"use client";

import { PublicKey } from "@solana/web3.js";

export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export const SYSVAR_RENT = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);
export const SYSVAR_CLOCK = new PublicKey(
  "SysvarC1ock11111111111111111111111111111111"
);

export type TokenType = 0 | 1;
export type TabId =
  | "stake"
  | "unstake"
  | "claim"
  | "swap"
  | "pool"
  | "liquidity"
  | "admin";

// Standardized transaction lifecycle.
export type TxStatus =
  | "idle"
  | "signing"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export const TOKEN_LABELS: Record<TokenType, string> = { 0: "SOL", 1: "USDC" };
export const TOKEN_DECIMALS: Record<TokenType, number> = { 0: 9, 1: 6 };
export const MIN_STAKE: Record<TokenType, string> = {
  0: "1 SOL",
  1: "1,000 USDC",
};

export const LAMPORTS = 1_000_000_000;
export const USDC_BASE = 1_000_000;

// Pyth oracle feed identifiers (price-service feed ids + on-chain pubkeys).
export {
  PYTH_SOL_FEED_ID,
  PYTH_USDC_FEED_ID,
  PYTH_SOL_FEED_PUBKEY,
  PYTH_USDC_FEED_PUBKEY,
} from "@/lib/oracle";
