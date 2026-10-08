"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  getStatePda,
  getUserStakePda,
  getRewardVaultPda,
  getPoolPda,
  getPoolTokenPda,
  getPoolLpMintPda,
} from "@/lib/pda";

export interface PortfolioPosition {
  stakedSol: string | null;
  pendingRewardsSol: string | null;
  stakedUsdc: string | null;
  pendingRewardsUsdc: string | null;
  lpTokens: string | null;
  lpShare: string | null;
}

export interface ProtocolState {
  paused: boolean | null;
  rewardRate: string | null;
  totalStakedSol: string | null;
  totalStakedUsdc: string | null;
  totalRewardsDistributed: string | null;
  timelockDelay: string | null;
  requiredSignatures: string | null;
  minStakeAmt: string | null;
  protocolFeeBps: string | null;
  flashLoanCbProgram: string | null;
  lastUpdateTime: string | null;
  rewardPerTokenStored: string | null;
  upgradeVersion: string | null;
  poolFee: string | null;
  poolFlashFee: string | null;
  poolSolBal: string | null;
  poolUsdcBal: string | null;
  solVault: string | null;
  usdcVault: string | null;
}

function readBigUint64(dv: DataView, offset: number): bigint {
  return dv.getBigUint64(offset, true);
}

/** Centralized, cacheable read of a user's on-chain positions. */
export function usePortfolio(provider: any, usdcMint: PublicKey) {
  const { publicKey: pk } = useWallet();
  const [data, setData] = useState<PortfolioPosition>({
    stakedSol: null,
    pendingRewardsSol: null,
    stakedUsdc: null,
    pendingRewardsUsdc: null,
    lpTokens: null,
    lpShare: null,
  });

  const refresh = useCallback(async () => {
    if (!provider || !pk) return;
    const conn = provider.connection;
    const next: PortfolioPosition = { ...data };
    try {
      const [pda] = getUserStakePda(pk, 0);
      const info = await conn.getAccountInfo(pda);
      if (info && info.data.length >= 80) {
        const dv = new DataView(
          info.data.buffer,
          info.data.byteOffset + 8,
          info.data.length - 8
        );
        next.stakedSol = (Number(readBigUint64(dv, 32)) / 1e9).toFixed(4);
        next.pendingRewardsSol = (Number(readBigUint64(dv, 56)) / 1e9).toFixed(
          6
        );
      } else {
        next.stakedSol = "0";
        next.pendingRewardsSol = "0";
      }
    } catch {
      next.stakedSol = null;
      next.pendingRewardsSol = null;
    }
    try {
      const [pda] = getUserStakePda(pk, 1);
      const info = await conn.getAccountInfo(pda);
      if (info && info.data.length >= 80) {
        const dv = new DataView(
          info.data.buffer,
          info.data.byteOffset + 8,
          info.data.length - 8
        );
        next.stakedUsdc = (Number(readBigUint64(dv, 32)) / 1e6).toFixed(2);
        next.pendingRewardsUsdc = (Number(readBigUint64(dv, 56)) / 1e6).toFixed(
          6
        );
      } else {
        next.stakedUsdc = "0";
        next.pendingRewardsUsdc = "0";
      }
    } catch {
      next.stakedUsdc = null;
      next.pendingRewardsUsdc = null;
    }
    try {
      const [poolPda] = getPoolPda(
        new PublicKey("So11111111111111111111111111111111111111112"),
        usdcMint
      );
      const [lpMint] = getPoolLpMintPda(poolPda);
      const ata = getAssociatedTokenAddressSync(lpMint, pk);
      const info = await conn.getAccountInfo(ata);
      if (info && info.data.length >= 72) {
        const bal = new DataView(
          info.data.buffer,
          info.data.byteOffset + 64,
          8
        ).getBigUint64(0, true);
        next.lpTokens = (Number(bal) / 1e9).toFixed(6);
        const mintInfo = await conn.getAccountInfo(lpMint);
        if (mintInfo && mintInfo.data.length >= 44) {
          const supply = new DataView(
            mintInfo.data.buffer,
            mintInfo.data.byteOffset + 36,
            8
          ).getBigUint64(0, true);
          if (supply > BigInt(0)) {
            const share = (Number(bal) / Number(supply)) * 100;
            next.lpShare = share < 0.01 ? "<0.01" : share.toFixed(2);
          } else next.lpShare = "0";
        }
      } else {
        next.lpTokens = "0";
        next.lpShare = "0";
      }
    } catch {
      next.lpTokens = null;
      next.lpShare = null;
    }
    setData(next);
  }, [provider, pk, usdcMint, data]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { portfolio: data, refresh };
}

/** Reads live protocol state and pool metrics once (caller decides cadence). */
export async function fetchProtocolState(
  provider: any,
  usdcMint: PublicKey
): Promise<ProtocolState> {
  const conn = provider.connection;
  const out: ProtocolState = {
    paused: null,
    rewardRate: null,
    totalStakedSol: null,
    totalStakedUsdc: null,
    totalRewardsDistributed: null,
    timelockDelay: null,
    requiredSignatures: null,
    minStakeAmt: null,
    protocolFeeBps: null,
    flashLoanCbProgram: null,
    lastUpdateTime: null,
    rewardPerTokenStored: null,
    upgradeVersion: null,
    poolFee: null,
    poolFlashFee: null,
    poolSolBal: null,
    poolUsdcBal: null,
    solVault: null,
    usdcVault: null,
  };

  try {
    const [statePda] = getStatePda();
    const info = await conn.getAccountInfo(statePda);
    if (info && info.data.length >= 8) {
      const data = info.data;
      const dv = new DataView(data.buffer, data.byteOffset, data.length);
      let offset = 8;
      offset += 32 + 32 + 32 + 32; // authority + 3 signers
      out.requiredSignatures = String(dv.getUint8(offset));
      offset += 1;
      out.totalStakedSol = (
        Number(dv.getBigUint64(offset, true)) / 1e9
      ).toFixed(4);
      offset += 8;
      out.totalStakedUsdc = (
        Number(dv.getBigUint64(offset, true)) / 1e6
      ).toFixed(2);
      offset += 8;
      out.paused = dv.getUint8(offset) === 1;
      offset += 1;
      out.rewardRate = String(dv.getBigUint64(offset, true));
      offset += 8;
      out.totalRewardsDistributed = (
        Number(dv.getBigUint64(offset, true)) / 1e9
      ).toFixed(4);
      offset += 8;
      offset += 6; // bumps
      const ltu = dv.getBigInt64(offset, true);
      offset += 8;
      out.lastUpdateTime = ltu
        ? new Date(Number(ltu) * 1000).toLocaleString()
        : "N/A";
      const rptsHi = dv.getBigUint64(offset, true);
      offset += 8;
      const rptsLo = dv.getBigUint64(offset, true);
      offset += 8;
      out.rewardPerTokenStored =
        rptsHi > BigInt(0) ? `${rptsHi}.${rptsLo}` : String(rptsLo);
      const tld = dv.getBigInt64(offset, true);
      offset += 8;
      out.timelockDelay = tld ? `${Number(tld) / 3600}h` : "0h";
      const hasPending = dv.getUint8(offset) === 1;
      offset += 1;
      if (hasPending) {
        offset += 1; // action type
        offset += 8; // proposed_at
        const vecLen = dv.getUint32(offset, true);
        offset += 4;
        offset += vecLen;
        offset += 3 + 32; // approvals + created_by
      }
      out.upgradeVersion = String(dv.getUint8(offset));
      offset += 1;
      offset += 16; // precision
      out.minStakeAmt = (Number(dv.getBigUint64(offset, true)) / 1e9).toFixed(
        4
      );
      offset += 8;
      out.protocolFeeBps = String(dv.getUint16(offset, true));
      offset += 2;
      const flcbBytes = new Uint8Array(
        data.buffer,
        data.byteOffset + offset,
        32
      );
      const flcbPk = new PublicKey(flcbBytes);
      out.flashLoanCbProgram = flcbPk.equals(PublicKey.default)
        ? "Not set"
        : `${flcbPk.toBase58().slice(0, 8)}...`;
      offset += 32;
    }
  } catch {}

  try {
    const [rvSol] = getRewardVaultPda(0);
    const info = await conn.getAccountInfo(rvSol);
    if (info && info.data.length >= 72) {
      const raw = new DataView(
        info.data.buffer,
        info.data.byteOffset + 64,
        8
      ).getBigUint64(0, true);
      out.solVault = (Number(raw) / 1e9).toFixed(4);
    }
  } catch {}

  try {
    const [rvUsdc] = getRewardVaultPda(1);
    const info = await conn.getAccountInfo(rvUsdc);
    if (info && info.data.length >= 72) {
      const raw = new DataView(
        info.data.buffer,
        info.data.byteOffset + 64,
        8
      ).getBigUint64(0, true);
      out.usdcVault = (Number(raw) / 1e6).toFixed(2);
    }
  } catch {}

  try {
    const wsol = new PublicKey("So11111111111111111111111111111111111111112");
    const [poolPda] = getPoolPda(wsol, usdcMint);
    const pinfo = await conn.getAccountInfo(poolPda);
    if (pinfo && pinfo.data.length >= 8) {
      const dv = new DataView(
        pinfo.data.buffer,
        pinfo.data.byteOffset,
        pinfo.data.length
      );
      let offset = 8 + 1; // discriminator + bump
      offset += 32 * 6; // token_a_mint, token_b_mint, token_a_account, token_b_account, lp_token_mint, lp_lock_account
      const fee = dv.getUint16(offset, true);
      offset += 2;
      out.poolFee = `${fee} bps (${(fee / 100).toFixed(2)}%)`;
      offset += 16;
      const ff = dv.getUint16(offset, true);
      offset += 2;
      out.poolFlashFee = `${ff} bps (${(ff / 100).toFixed(2)}%)`;
    }
    const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
    const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
    const [aInfo, bInfo] = await Promise.all([
      conn.getAccountInfo(poolTokenA),
      conn.getAccountInfo(poolTokenB),
    ]);
    if (aInfo && aInfo.data.length >= 72) {
      const bal = new DataView(
        aInfo.data.buffer,
        aInfo.data.byteOffset + 64,
        8
      ).getBigUint64(0, true);
      out.poolSolBal = `${(Number(bal) / 1e9).toFixed(4)} SOL`;
    }
    if (bInfo && bInfo.data.length >= 72) {
      const bal = new DataView(
        bInfo.data.buffer,
        bInfo.data.byteOffset + 64,
        8
      ).getBigUint64(0, true);
      out.poolUsdcBal = `${(Number(bal) / 1e6).toFixed(2)} USDC`;
    }
  } catch {}

  return out;
}
