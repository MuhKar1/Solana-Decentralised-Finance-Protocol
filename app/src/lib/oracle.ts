"use client";

import { PublicKey } from "@solana/web3.js";
import type { AnchorProvider } from "@coral-xyz/anchor";
import { getPoolPda, sortMintPair } from "@/lib/pda";

// ---------------------------------------------------------------------------
// Pyth oracle configuration.
//
// Each token maps to two identifiers:
//   - `feedId`    : the Pyth price-feed id used by the Hermes price service
//                   (https://hermes.pyth.network/v2/updates/price/latest) to
//                   fetch off-chain display prices.
//   - `feedPubkey`: the on-chain Pyth price-feed *account* that the Solana
//                   program validates during `swap` (stored in the Pool).
//
// Devnet Pyth accounts mirror mainnet prices, so the UI fetches display prices
// via Hermes mainnet feed ids while the on-chain instructions reference the
// devnet feed account addresses.
// ---------------------------------------------------------------------------

export interface OracleFeed {
  symbol: string;
  /** Pyth feed id (64-hex chars, no 0x) used by Hermes. */
  feedId: string;
  /** On-chain Pyth price-feed account pubkey. */
  feedPubkey: PublicKey;
}

export const PYTH_SOL_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const PYTH_USDC_FEED_ID =
  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

export const PYTH_SOL_FEED_PUBKEY = new PublicKey(
  "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLREzNjY5K46t"
);
export const PYTH_USDC_FEED_PUBKEY = new PublicKey(
  "5SSkXsEKQepjZTH3T3rK3aWpYd5Bq4QpW5uR5k2R9L5r"
);

export const ORACLE_FEEDS: Record<"SOL" | "USDC", OracleFeed> = {
  SOL: {
    symbol: "SOL/USD",
    feedId: PYTH_SOL_FEED_ID,
    feedPubkey: PYTH_SOL_FEED_PUBKEY,
  },
  USDC: {
    symbol: "USDC/USD",
    feedId: PYTH_USDC_FEED_ID,
    feedPubkey: PYTH_USDC_FEED_PUBKEY,
  },
};

export function feedForMint(
  mint: PublicKey,
  usdcMint: PublicKey,
  solFeed: PublicKey = PYTH_SOL_FEED_PUBKEY,
  usdcFeed: PublicKey = PYTH_USDC_FEED_PUBKEY
): PublicKey {
  const wsol = new PublicKey("So11111111111111111111111111111111111111112");
  if (mint.equals(wsol)) return solFeed;
  if (mint.equals(usdcMint)) return usdcFeed;
  return PublicKey.default;
}

/** Price snapshot returned by the Hermes price service. */
export interface PythPrice {
  /** Raw integer price (not scaled by expo). */
  price: string;
  /** Confidence interval (same units as `price`). */
  conf: string;
  /** Exponent applied to the raw price (price * 10^expo = USD). */
  expo: number;
  /** Publish timestamp in seconds. */
  publishTime: number;
}

/** Canonical USD price = raw * 10^expo. */
export function toUsd(price: { price: string; expo: number }): number {
  return Number(price.price) * Math.pow(10, price.expo);
}

/**
 * Fetch latest prices for one or more Pyth feed ids from the Hermes price
 * service. Returns a map keyed by feed id (without the leading "0x").
 * Throws if the request fails or a feed is missing.
 */
export async function fetchHermesPrices(
  feedIds: string[]
): Promise<Record<string, PythPrice>> {
  const ids = feedIds.map((id) => id.replace(/^0x/, ""));
  const query = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(
    `https://hermes.pyth.network/v2/updates/price/latest?${query}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Hermes price request failed: ${res.status}`);
  }
  const data = await res.json();
  const out: Record<string, PythPrice> = {};
  for (const item of data?.parsed ?? []) {
    if (item?.price?.price == null) continue;
    const id: string = String(item.id).replace(/^0x/, "");
    out[id] = {
      price: String(item.price.price),
      conf: String(item.price.conf),
      expo: Number(item.price.expo),
      publishTime: Number(item.price.publish_time ?? 0),
    };
  }
  return out;
}

export interface PoolOracleFeeds {
  feedA: PublicKey;
  feedB: PublicKey;
  /** Whether feedA == SOL feed and feedB == USDC feed (expected ordering). */
  matchesExpected: boolean;
}

/**
 * Read the Pool account and decode the two Pyth feed pubkeys stored on-chain.
 * The Pool binary layout (Anchor, post discriminant) is:
 *
 *   bump                (1)
 *   token_a_mint        (32)
 *   token_b_mint        (32)
 *   token_a_account     (32)
 *   token_b_account     (32)
 *   lp_token_mint       (32)
 *   lp_lock_account     (32)
 *   fee_basis_points    (2)
 *   k_last              (16)
 *   flash_loan_fee_bps  (2)
 *   pyth_price_feed_a   (32)
 *   pyth_price_feed_b   (32)
 */
export async function derivePoolOracleFeeds(
  provider: AnchorProvider,
  usdcMint: PublicKey
): Promise<PoolOracleFeeds | null> {
  if (!provider) return null;
  const conn = provider.connection;
  const wsol = new PublicKey("So11111111111111111111111111111111111111112");
  const [tokenA, tokenB] = sortMintPair(wsol, usdcMint);
  const [poolPda] = getPoolPda(tokenA, tokenB);
  const info = await conn.getAccountInfo(poolPda);
  if (!info || info.data.length < 253 + 32) return null;

  const data = info.data;
  // 8 (discriminator) + 1 (bump) + 32*6 (mints/accounts) + 2 (fee) + 16 (k_last) + 2 (flash fee) = 221
  const feedAOffset = 221;
  const feedBOffset = 221 + 32;
  const feedA = new PublicKey(
    new Uint8Array(data.buffer, data.byteOffset + feedAOffset, 32)
  );
  const feedB = new PublicKey(
    new Uint8Array(data.buffer, data.byteOffset + feedBOffset, 32)
  );
  const matchesExpected =
    feedA.equals(feedForMint(tokenA, usdcMint)) &&
    feedB.equals(feedForMint(tokenB, usdcMint));
  return { feedA, feedB, matchesExpected };
}
