"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "@/hooks/use-program";
import { getUsdcMint } from "@/lib/usdc-mint";
import type { TabId } from "@/lib/constants";
import { KV } from "@/components/ui";
import { WelcomeScreen } from "@/components/welcome";
import { StakePanel, UnstakePanel, ClaimPanel } from "@/components/staking";
import { SwapPanel, LiquidityPanel, PoolInfoPanel } from "@/components/amm";
import { AdminPanel } from "@/components/admin";
import { usePortfolio } from "@/hooks/use-protocol-data";

export default function Home() {
  const { connected } = useWallet();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <div className="glass glow rounded-2xl sm:rounded-3xl p-6 sm:p-10 md:p-14 max-w-2xl w-full mx-2 sm:mx-0 space-y-5 text-center">
            <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center shadow-xl shadow-sky-500/20">
              <span className="text-white text-2xl sm:text-3xl font-bold">D</span>
            </div>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gradient tracking-tight">
              Solana DeFi Protocol
            </h2>
            <p className="text-slate-400 text-sm max-w-md mx-auto leading-relaxed">
              Connecting to wallet...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6">
      {!connected ? <WelcomeScreen /> : <Dashboard />}
    </div>
  );
}

function Dashboard() {
  const { publicKey: walletPk } = useWallet();
  const { program, provider } = useProgram();
  const usdcMint = getUsdcMint();
  const [tab, setTab] = useState<TabId>("stake");
  const [isAdmin, setIsAdmin] = useState(false);

  // Auto-detect admin access from on-chain authority + signers.
  useEffect(() => {
    if (!provider || !walletPk) return;
    (async () => {
      try {
        const [statePda] = (await import("@/lib/pda")).getStatePda();
        const info = await provider.connection.getAccountInfo(statePda);
        if (info && info.data.length >= 136) {
          const authority = new PublicKey(info.data.slice(40, 72));
          const s1 = new PublicKey(info.data.slice(72, 104));
          const s2 = new PublicKey(info.data.slice(104, 136));
          setIsAdmin(
            walletPk.equals(authority) || walletPk.equals(s1) || walletPk.equals(s2)
          );
        }
      } catch {
        setIsAdmin(false);
      }
    })();
  }, [provider, walletPk]);

  const tabs: { id: TabId; label: string; icon: string; adminOnly?: boolean }[] = [
    { id: "stake", label: "Stake", icon: "📥" },
    { id: "unstake", label: "Unstake", icon: "📤" },
    { id: "claim", label: "Claim", icon: "🎁" },
    { id: "swap", label: "Swap", icon: "🔄" },
    { id: "pool", label: "Pool", icon: "📊" },
    { id: "liquidity", label: "Liquidity", icon: "💧" },
    { id: "admin", label: "Admin", icon: "⚙️", adminOnly: true },
  ];
  const visible = tabs.filter((t) => !t.adminOnly || isAdmin);
  const base58 = walletPk?.toBase58() ?? "";

  return (
    <div className="space-y-4 sm:space-y-6 animate-fade-in">
      <PortfolioBar provider={provider} usdcMint={usdcMint} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-gradient tracking-tight">
            Dashboard
          </h2>
          <p className="text-slate-500 text-xs sm:text-sm mt-0.5 break-all">
            <span className="font-mono text-sky-400 text-xs sm:text-sm">
              {base58.slice(0, 4)}..{base58.slice(-3)}
            </span>
          </p>
        </div>
      </div>

      <div className="flex gap-1.5 sm:gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {visible.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${
              tab === t.id
                ? "bg-sky-500/20 border border-sky-400/40 text-sky-300 shadow-lg shadow-sky-500/10"
                : "glass text-slate-400 hover:text-slate-200 hover:border-sky-500/20"
            }`}
          >
            <span className="mr-1 sm:mr-1.5">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="glass glow rounded-xl sm:rounded-2xl p-4 sm:p-6 md:p-8">
        {tab === "stake" && <StakePanel program={program} provider={provider} usdcMint={usdcMint} />}
        {tab === "unstake" && <UnstakePanel program={program} provider={provider} usdcMint={usdcMint} />}
        {tab === "claim" && <ClaimPanel program={program} provider={provider} usdcMint={usdcMint} />}
        {tab === "swap" && <SwapPanel program={program} provider={provider} usdcMint={usdcMint} />}
        {tab === "pool" && <PoolInfoPanel provider={provider} usdcMint={usdcMint} />}
        {tab === "liquidity" && <LiquidityPanel program={program} provider={provider} usdcMint={usdcMint} />}
        {tab === "admin" && <AdminPanel program={program} provider={provider} />}
      </div>
    </div>
  );
}

function PortfolioBar({
  provider,
  usdcMint,
}: {
  provider: any;
  usdcMint: PublicKey;
}) {
  const { portfolio } = usePortfolio(provider, usdcMint);
  return (
    <div className="rounded-xl border border-emerald-500/10 overflow-hidden">
      <div className="p-2 sm:p-3 bg-emerald-500/5 border-b border-emerald-500/10">
        <h4 className="text-xs font-semibold text-emerald-400 flex items-center gap-2">
          <span>📊</span> My Portfolio
        </h4>
      </div>
      <div className="p-2 sm:p-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
        <KV label="Staked SOL" value={portfolio.stakedSol !== null ? `${portfolio.stakedSol} SOL` : "—"} />
        <KV label="SOL Rewards" value={portfolio.pendingRewardsSol !== null ? `${portfolio.pendingRewardsSol} SOL` : "—"} accent={portfolio.pendingRewardsSol && parseFloat(portfolio.pendingRewardsSol) > 0 ? "text-amber-300" : undefined} />
        <KV label="Staked USDC" value={portfolio.stakedUsdc !== null ? `${portfolio.stakedUsdc} USDC` : "—"} />
        <KV label="USDC Rewards" value={portfolio.pendingRewardsUsdc !== null ? `${portfolio.pendingRewardsUsdc} USDC` : "—"} accent={portfolio.pendingRewardsUsdc && parseFloat(portfolio.pendingRewardsUsdc) > 0 ? "text-amber-300" : undefined} />
        <KV label="LP Tokens" value={portfolio.lpTokens !== null ? `${portfolio.lpTokens} LP` : "—"} />
        <KV label="Pool Share" value={portfolio.lpShare !== null ? `${portfolio.lpShare}%` : "—"} />
      </div>
    </div>
  );
}