"use client";

import { useCallback, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import {
  useStake,
  useUnstake,
  useEmergencyUnstake,
  useClaim,
  useUpdateRewards,
  useCloseStakeAccount,
} from "@/hooks/use-staking";
import { useTx } from "@/hooks/use-tx";
import { usePortfolio } from "@/hooks/use-protocol-data";
import { LAMPORTS, USDC_BASE } from "@/lib/constants";
import type { TokenType } from "@/lib/constants";
import { Inp, ABtn, Err, Ok, TS, KV } from "@/components/ui";

function amountToRaw(tt: TokenType, input: string): { p: number; raw: BN } {
  const p = parseFloat(input);
  const base = tt === 0 ? LAMPORTS : USDC_BASE;
  return { p, raw: new BN(Math.floor(p * base)) };
}

export function StakePanel({
  program,
  provider,
  usdcMint,
}: {
  program: any;
  provider: any;
  usdcMint: any;
}) {
  const stake = useStake(program, provider, usdcMint);
  const tx = useTx();
  const { portfolio, refresh } = usePortfolio(provider, usdcMint);

  const runStake = useCallback(
    async (tt: TokenType, input: string) => {
      await tx.run(async () => {
        const { p, raw } = amountToRaw(tt, input);
        if (isNaN(p) || p <= 0)
          throw new Error("Enter a valid positive amount.");
        if (tt === 0 && raw.lt(new BN(LAMPORTS)))
          throw new Error("Minimum: 1 SOL.");
        if (tt === 1 && raw.lt(new BN(1_000_000_000)))
          throw new Error("Minimum: 1,000 USDC (contract-enforced).");
        return stake(tt, raw);
      }, `Staked ${input} ${tt === 0 ? "SOL" : "USDC"}`);
      refresh();
    },
    [stake, tx, refresh]
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-white">Stake</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Earn yield by depositing SOL or USDC
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StakeCard
          tt={0}
          title="SOL Staking"
          subtitle="Auto-wraps to WSOL · Min 1 SOL"
          yourStake={portfolio.stakedSol}
          onStake={(input) => runStake(0, input)}
          status={tx.status}
        />
        <StakeCard
          tt={1}
          title="USDC Staking"
          subtitle="Min 1,000 USDC · Contract-enforced"
          yourStake={portfolio.stakedUsdc}
          onStake={(input) => runStake(1, input)}
          status={tx.status}
        />
      </div>
      <Err message={tx.error} />
      <Ok message={tx.ok} />
    </div>
  );
}

function StakeCard({
  tt,
  title,
  subtitle,
  yourStake,
  onStake,
  status,
}: {
  tt: TokenType;
  title: string;
  subtitle: string;
  yourStake: string | null;
  onStake: (input: string) => void;
  status: any;
}) {
  const [amt, setAmt] = useState("");
  const symbol = tt === 0 ? "SOL" : "USDC";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center">
          <span className="text-xs font-bold text-white">{symbol[0]}</span>
        </div>
        <div>
          <h4 className="text-sm font-medium text-white">{title}</h4>
          <p className="text-[11px] text-slate-500">{subtitle}</p>
        </div>
      </div>
      <div className="mb-4 flex items-center justify-between text-xs">
        <span className="text-slate-500">Your stake</span>
        <span className="text-slate-300 font-mono">
          {yourStake !== null ? `${yourStake} ${symbol}` : "—"}
        </span>
      </div>
      <Inp
        label="Amount"
        val={amt}
        set={setAmt}
        ph={tt === 0 ? "1.0" : "1000"}
      />
      <div className="mt-3">
        <ABtn
          label={`Stake ${symbol}`}
          onClick={() => onStake(amt)}
          status={status}
          disabled={!amt}
        />
      </div>
    </div>
  );
}

export function UnstakePanel({
  program,
  provider,
  usdcMint,
}: {
  program: any;
  provider: any;
  usdcMint: any;
}) {
  const unstake = useUnstake(program, provider, usdcMint);
  const emergency = useEmergencyUnstake(program, provider, usdcMint);
  const tx = useTx();
  const { portfolio, refresh } = usePortfolio(provider, usdcMint);

  const runUnstake = useCallback(
    async (tt: TokenType, input: string) => {
      await tx.run(async () => {
        const { p, raw } = amountToRaw(tt, input);
        if (isNaN(p) || p <= 0)
          throw new Error("Enter a valid positive amount.");
        return unstake(tt, raw);
      }, `Unstaked ${input}`);
      refresh();
    },
    [unstake, tx, refresh]
  );

  const runEmergency = useCallback(
    async (tt: TokenType) => {
      await tx.run(
        () => emergency(tt),
        `Emergency unstaked ${tt === 0 ? "SOL" : "USDC"}`
      );
      refresh();
    },
    [emergency, tx, refresh]
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">
          Unstake Tokens
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Withdraw staked tokens from either pool. Rewards update automatically.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <UnstakeCard
          tt={0}
          yourStake={portfolio.stakedSol}
          onUnstake={(i) => runUnstake(0, i)}
          onEmergency={() => runEmergency(0)}
          status={tx.status}
        />
        <UnstakeCard
          tt={1}
          yourStake={portfolio.stakedUsdc}
          onUnstake={(i) => runUnstake(1, i)}
          onEmergency={() => runEmergency(1)}
          status={tx.status}
        />
      </div>
      <Err message={tx.error} />
      <Ok message={tx.ok} />
    </div>
  );
}

function UnstakeCard({
  tt,
  yourStake,
  onUnstake,
  onEmergency,
  status,
}: {
  tt: TokenType;
  yourStake: string | null;
  onUnstake: (input: string) => void;
  onEmergency: () => void;
  status: any;
}) {
  const [amt, setAmt] = useState("");
  const symbol = tt === 0 ? "SOL" : "USDC";
  return (
    <div className="glass rounded-xl p-4 border-sky-500/10 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">{tt === 0 ? "☀️" : "💵"}</span>
        <h4 className="text-sm font-semibold text-sky-300">Unstake {symbol}</h4>
      </div>
      <div className="p-2 rounded-lg bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs space-y-1">
        <div className="flex justify-between">
          <span>Your stake</span>
          <span className="font-mono">
            {yourStake !== null ? `${yourStake} ${symbol}` : "—"}
          </span>
        </div>
      </div>
      <Inp label={`Amount (${symbol})`} val={amt} set={setAmt} ph="0.0" />
      <ABtn
        label={`Unstake ${symbol}`}
        onClick={() => onUnstake(amt)}
        status={status}
        disabled={!amt}
      />
      <div className="pt-2 border-t border-sky-500/10">
        <ABtn
          label={`Emergency Unstake ${symbol}`}
          onClick={onEmergency}
          status={status}
        />
      </div>
    </div>
  );
}

export function ClaimPanel({
  program,
  provider,
  usdcMint,
}: {
  program: any;
  provider: any;
  usdcMint: any;
}) {
  const claim = useClaim(program, provider, usdcMint);
  const updateRewards = useUpdateRewards(program, provider);
  const closeStake = useCloseStakeAccount(program, provider);
  const tx = useTx();
  const { portfolio, refresh } = usePortfolio(provider, usdcMint);
  const [tt, setTt] = useState<TokenType>(0);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">
          Claim Rewards
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Collect accrued staking rewards and manage your stake accounts.
        </p>
      </div>
      <TS value={tt} onChange={setTt} />
      <div className="grid grid-cols-2 gap-2">
        <KV
          label="SOL Rewards"
          value={
            portfolio.pendingRewardsSol !== null
              ? `${portfolio.pendingRewardsSol} SOL`
              : "—"
          }
        />
        <KV
          label="USDC Rewards"
          value={
            portfolio.pendingRewardsUsdc !== null
              ? `${portfolio.pendingRewardsUsdc} USDC`
              : "—"
          }
        />
      </div>
      <ABtn
        label="Claim Rewards"
        onClick={async () => {
          await tx.run(() => claim(tt), "Rewards claimed!");
          refresh();
        }}
        status={tx.status}
      />
      <div className="flex gap-2">
        <button
          onClick={() => tx.run(() => updateRewards(tt), "Rewards updated!")}
          disabled={tx.status !== "idle"}
          className="flex-1 py-2 rounded-xl text-xs font-semibold bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 transition-all disabled:opacity-40"
        >
          🔄 Update Rewards
        </button>
        <button
          onClick={() => tx.run(() => closeStake(tt), "Stake account closed!")}
          disabled={tx.status !== "idle"}
          className="flex-1 py-2 rounded-xl text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-40"
        >
          🗑️ Close Account
        </button>
      </div>
      <Err message={tx.error} />
      <Ok message={tx.ok} />
    </div>
  );
}
