"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { FC } from "@/components/ui";

export function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] sm:min-h-[70vh] text-center animate-fade-in">
      <div className="glass glow rounded-2xl sm:rounded-3xl p-6 sm:p-10 md:p-14 max-w-2xl w-full mx-2 sm:mx-0 space-y-5 sm:space-y-6">
        <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center shadow-xl shadow-sky-500/20">
          <span className="text-white text-2xl sm:text-3xl font-bold">D</span>
        </div>
        <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gradient tracking-tight">
          Solana DeFi Protocol
        </h2>
        <p className="text-slate-400 text-sm sm:text-base max-w-md mx-auto leading-relaxed">
          A production-oriented decentralized finance protocol featuring{" "}
          <strong>multi-signature governance</strong>,{" "}
          <strong>yield-bearing staking pools</strong> (SOL & USDC), an{" "}
          <strong>automated market maker</strong> with flash loan support, and
          emergency safety mechanisms — running on Solana Devnet.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 text-left mt-4 sm:mt-6">
          <FC
            emoji="🔐"
            title="Multi-Sig Admin"
            desc="3-of-3 signer governance with timelock"
          />
          <FC
            emoji="💧"
            title="Liquidity Pools"
            desc="Constant-product AMM with flash loans"
          />
          <FC
            emoji="🏆"
            title="Staking Rewards"
            desc="Stake SOL or USDC to earn yield"
          />
        </div>
        <div className="pt-2 sm:pt-4">
          <WalletMultiButton />
        </div>
      </div>
    </div>
  );
}
