"use client";

import { PublicKey } from "@solana/web3.js";

const USDC_MINT_KEY = "defi_usdc_mint";

let _usdcMint: PublicKey = (() => {
  try {
    const saved =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(USDC_MINT_KEY)
        : null;
    if (saved) return new PublicKey(saved);
  } catch {}
  return PublicKey.default;
})();

export function getUsdcMint(): PublicKey {
  return _usdcMint;
}

export function setUsdcMint(mint: PublicKey): void {
  _usdcMint = mint;
  try {
    localStorage.setItem(USDC_MINT_KEY, mint.toBase58());
  } catch {}
}

export function hasUsdcMint(): boolean {
  return !_usdcMint.equals(PublicKey.default);
}
