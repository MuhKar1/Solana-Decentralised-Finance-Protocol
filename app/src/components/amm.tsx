"use client";

import { useCallback, useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useSwap, useAddLiquidity, useRemoveLiquidity } from "@/hooks/use-amm";
import { useTx } from "@/hooks/use-tx";
import { usePortfolio, fetchProtocolState } from "@/hooks/use-protocol-data";
import { LAMPORTS, USDC_BASE } from "@/lib/constants";
import { Inp, ABtn, Err, Ok, KV, SC } from "@/components/ui";
import {
  usePythPrices,
  formatUsdPrice,
  solUsdcRate,
} from "@/hooks/use-pyth-prices";
import { OracleBadges, OracleFeedCard } from "@/components/oracle";
import { derivePoolOracleFeeds } from "@/lib/oracle";
import type { PublicKey } from "@solana/web3.js";

export function SwapPanel({
  program,
  provider,
  usdcMint,
}: {
  program: any;
  provider: any;
  usdcMint: any;
}) {
  const swap = useSwap(program, provider, usdcMint);
  const tx = useTx();
  const { sol, usdc } = usePythPrices();
  const [amtIn, setAmtIn] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [feeds, setFeeds] = useState<{
    feedA: PublicKey;
    feedB: PublicKey;
  } | null>(null);

  const rate = solUsdcRate(sol, usdc);

  useEffect(() => {
    if (!provider) return;
    derivePoolOracleFeeds(provider, usdcMint)
      .then((f) => f && setFeeds({ feedA: f.feedA, feedB: f.feedB }))
      .catch(() => {});
  }, [provider, usdcMint]);

  const pIn = parseFloat(amtIn);
  const estimatedOut =
    !isNaN(pIn) && pIn > 0 && rate !== null ? pIn * rate : null;

  const run = useCallback(async () => {
    const input = parseFloat(amtIn);
    await tx.run(async () => {
      if (isNaN(input) || input <= 0)
        throw new Error("Enter a valid input amount.");
      const slp = parseFloat(slippage);
      if (isNaN(slp) || slp < 0) throw new Error("Enter a valid slippage.");
      // The program is authoritative; the frontend passes a conservative
      // min-out derived from the user's tolerance.
      const rawIn = new BN(Math.floor(input * LAMPORTS));
      const rawOut = new BN(
        Math.floor(Math.max(0, input * (1 - slp / 100)) * USDC_BASE)
      );
      const sig = await swap(rawIn, rawOut);
      setAmtIn("");
      return sig;
    }, "Swap executed!");
  }, [swap, tx, amtIn, slippage]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">
          Swap Tokens
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Swap SOL → USDC via the AMM pool.
        </p>
      </div>

      <div className="glass rounded-xl p-3 sm:p-4 border-sky-500/10">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs text-slate-400 uppercase tracking-wider">
            Pyth Oracle Quote
          </p>
          <span className="text-[10px] font-mono text-slate-500">
            price feed driven
          </span>
        </div>
        <div className="text-xs sm:text-sm font-mono text-slate-300 space-y-1">
          <div>
            SOL/USD: <span className="text-sky-300">{formatUsdPrice(sol)}</span>
          </div>
          <div>
            USDC/USD:{" "}
            <span className="text-emerald-300">{formatUsdPrice(usdc)}</span>
          </div>
          <div>
            1 SOL ≈ {rate !== null ? `${rate.toFixed(4)} USDC` : "—"}{" "}
            <span className="text-slate-500">(implied by oracle)</span>
          </div>
        </div>
      </div>

      <Inp label="Amount In (SOL)" val={amtIn} set={setAmtIn} ph="0.0" />

      {estimatedOut !== null && (
        <p className="text-xs text-slate-400">
          Estimated output:{" "}
          <span className="font-mono text-slate-200">
            {estimatedOut.toFixed(4)} USDC
          </span>{" "}
          <span className="text-slate-500">(before slippage/fees)</span>
        </p>
      )}

      <div>
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Slippage Tolerance (%)
        </label>
        <div className="flex gap-2 mt-1.5">
          {["0.5", "1", "3"].map((v) => (
            <button
              key={v}
              onClick={() => setSlippage(v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                slippage === v
                  ? "bg-sky-500/20 border border-sky-400/40 text-sky-300"
                  : "glass text-slate-500 hover:text-slate-300"
              }`}
            >
              {v}%
            </button>
          ))}
          <input
            type="number"
            step="0.1"
            min="0"
            max="50"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
            className="w-20 px-2 py-1.5 rounded-lg glass border border-sky-500/10 text-slate-200 text-xs font-mono focus:border-sky-400/40 focus:outline-none"
          />
          <span className="text-xs text-slate-500 self-center">%</span>
        </div>
      </div>

      <OracleFeedCard feedA={feeds?.feedA} feedB={feeds?.feedB} />

      <ABtn
        label="Swap SOL → USDC"
        onClick={run}
        status={tx.status}
        disabled={!amtIn}
      />
      <Err message={tx.error} />
      <Ok message={tx.ok} />
    </div>
  );
}

export function LiquidityPanel({
  program,
  provider,
  usdcMint,
}: {
  program: any;
  provider: any;
  usdcMint: any;
}) {
  const add = useAddLiquidity(program, provider, usdcMint);
  const remove = useRemoveLiquidity(program, provider, usdcMint);
  const tx = useTx();
  const { portfolio, refresh } = usePortfolio(provider, usdcMint);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amtA, setAmtA] = useState("");
  const [amtB, setAmtB] = useState("");
  const [minLp, setMinLp] = useState("");
  const [lpAmt, setLpAmt] = useState("");
  const [minA, setMinA] = useState("");
  const [minB, setMinB] = useState("");

  const runAdd = useCallback(async () => {
    await tx.run(async () => {
      const a = parseFloat(amtA);
      const b = parseFloat(amtB);
      const m = parseFloat(minLp);
      if (isNaN(a) || a <= 0) throw new Error("Enter valid Amount A (SOL).");
      if (isNaN(b) || b <= 0) throw new Error("Enter valid Amount B (USDC).");
      if (isNaN(m) || m < 0) throw new Error("Enter valid minimum LP amount.");
      const rawA = new BN(Math.floor(a * LAMPORTS));
      const rawB = new BN(Math.floor(b * USDC_BASE));
      const rawMin = new BN(Math.floor(m * LAMPORTS));
      const sig = await add(rawA, rawB, rawMin);
      setAmtA("");
      setAmtB("");
      setMinLp("");
      return sig;
    }, "Liquidity added!");
    refresh();
  }, [add, tx, amtA, amtB, minLp, refresh]);

  const runRemove = useCallback(async () => {
    await tx.run(async () => {
      const lp = parseFloat(lpAmt);
      const ma = parseFloat(minA);
      const mb = parseFloat(minB);
      if (isNaN(lp) || lp <= 0) throw new Error("Enter valid LP amount.");
      if (isNaN(ma) || ma < 0) throw new Error("Enter valid min Token A.");
      if (isNaN(mb) || mb < 0) throw new Error("Enter valid min Token B.");
      const rawLp = new BN(Math.floor(lp * LAMPORTS));
      const rawMA = new BN(Math.floor(ma * LAMPORTS));
      const rawMB = new BN(Math.floor(mb * USDC_BASE));
      const sig = await remove(rawLp, rawMA, rawMB);
      setLpAmt("");
      setMinA("");
      setMinB("");
      return sig;
    }, "Liquidity removed!");
    refresh();
  }, [remove, tx, lpAmt, minA, minB, refresh]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">
          Liquidity Management
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Add SOL+USDC to earn swap fees, or remove LP tokens.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KV
          label="LP Tokens"
          value={portfolio.lpTokens !== null ? `${portfolio.lpTokens} LP` : "—"}
        />
        <KV
          label="Pool Share"
          value={portfolio.lpShare !== null ? `${portfolio.lpShare}%` : "—"}
        />
        <KV
          label="Staked SOL"
          value={
            portfolio.stakedSol !== null ? `${portfolio.stakedSol} SOL` : "—"
          }
        />
        <KV
          label="Staked USDC"
          value={
            portfolio.stakedUsdc !== null ? `${portfolio.stakedUsdc} USDC` : "—"
          }
        />
      </div>
      <div className="flex gap-2">
        {(["add", "remove"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
              mode === m
                ? "bg-emerald-500/20 border border-emerald-400/40 text-emerald-300"
                : "glass text-slate-500 hover:text-slate-300"
            }`}
          >
            {m === "add" ? "+ Add" : "− Remove"}
          </button>
        ))}
      </div>
      {mode === "add" ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Inp label="Amount A (SOL)" val={amtA} set={setAmtA} />
            <Inp label="Amount B (USDC)" val={amtB} set={setAmtB} />
          </div>
          <Inp label="Min LP Tokens (slippage)" val={minLp} set={setMinLp} />
          <ABtn
            label="Add Liquidity"
            onClick={runAdd}
            status={tx.status}
            disabled={!amtA || !amtB}
          />
        </>
      ) : (
        <>
          <Inp label="LP Token Amount" val={lpAmt} set={setLpAmt} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Inp label="Min Token A (SOL)" val={minA} set={setMinA} />
            <Inp label="Min Token B (USDC)" val={minB} set={setMinB} />
          </div>
          <ABtn
            label="Remove Liquidity"
            onClick={runRemove}
            status={tx.status}
            disabled={!lpAmt}
          />
        </>
      )}
      <Err message={tx.error} />
      <Ok message={tx.ok} />
    </div>
  );
}

export function PoolInfoPanel({
  provider,
  usdcMint,
}: {
  provider: any;
  usdcMint: any;
}) {
  const [state, setState] = useState<any>(null);
  const [feeds, setFeeds] = useState<{
    feedA: PublicKey;
    feedB: PublicKey;
  } | null>(null);

  useEffect(() => {
    if (!provider) return;
    fetchProtocolState(provider, usdcMint).then(setState);
    derivePoolOracleFeeds(provider, usdcMint)
      .then((f) => f && setFeeds({ feedA: f.feedA, feedB: f.feedB }))
      .catch(() => {});
  }, [provider, usdcMint]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">
          Pool Information
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Constant-product AMM (x·y=k) between SOL and USDC.
        </p>
      </div>

      <OracleBadges />
      <OracleFeedCard feedA={feeds?.feedA} feedB={feeds?.feedB} />

      <div className="grid grid-cols-1 xs:grid-cols-2 gap-3 sm:gap-4">
        <SC label="Swap Fee" value={state?.poolFee ?? "..."} />
        <SC label="Flash Loan Fee" value={state?.poolFlashFee ?? "..."} />
        <SC label="SOL Liquidity" value={state?.poolSolBal ?? "..."} />
        <SC label="USDC Liquidity" value={state?.poolUsdcBal ?? "..."} />
        <SC
          label="Approved Flash Loan Callback"
          value={state?.flashLoanCbProgram ?? "..."}
        />
      </div>
    </div>
  );
}
