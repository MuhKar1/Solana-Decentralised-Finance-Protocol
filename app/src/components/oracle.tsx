"use client";

import { useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import {
  usePythPrices,
  formatUsdPrice,
  solUsdcRate,
} from "@/hooks/use-pyth-prices";
import { ORACLE_FEEDS } from "@/lib/oracle";

function compact(pk: string): string {
  return `${pk.slice(0, 6)}…${pk.slice(-6)}`;
}

export function OracleBadges() {
  const { sol, usdc, ageSeconds, stale, error } = usePythPrices();
  const rate = solUsdcRate(sol, usdc);

  return (
    <div className="glass rounded-xl p-3 sm:p-4 border-sky-500/10">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs text-slate-400 uppercase tracking-wider">
          Pyth Oracle
        </p>
        {error ? (
          <span className="text-[10px] font-mono text-red-400">offline</span>
        ) : stale ? (
          <span className="text-[10px] font-mono text-amber-400">
            ⚠ stale {ageSeconds}s
          </span>
        ) : (
          <span className="text-[10px] font-mono text-emerald-400">
            live{ageSeconds !== null ? ` · ${ageSeconds}s` : ""}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 xs:grid-cols-3 gap-2 text-xs sm:text-sm">
        <div className="flex flex-col">
          <span className="text-slate-500 text-[10px] uppercase tracking-wider">
            SOL/USD
          </span>
          <span className="font-mono text-sky-300">
            {sol ? `${formatUsdPrice(sol)}` : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-500 text-[10px] uppercase tracking-wider">
            USDC/USD
          </span>
          <span className="font-mono text-emerald-300">
            {usdc ? `${formatUsdPrice(usdc)}` : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-500 text-[10px] uppercase tracking-wider">
            SOL/USDC
          </span>
          <span className="font-mono text-slate-300">
            {rate !== null ? `1 : ${rate.toFixed(4)}` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

export function OracleFeedCard({
  feedA,
  feedB,
}: {
  feedA?: PublicKey | null;
  feedB?: PublicKey | null;
}) {
  const [copied, setCopied] = useState<"a" | "b" | null>(null);

  const expectedA = ORACLE_FEEDS.SOL.feedPubkey;
  const expectedB = ORACLE_FEEDS.USDC.feedPubkey;
  const matches = feedA?.equals(expectedA) && feedB?.equals(expectedB);

  const copy = (kind: "a" | "b", value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  const row = (
    label: string,
    feed: PublicKey | undefined,
    expected: PublicKey,
    kind: "a" | "b"
  ) => {
    const value = feed ? feed.toBase58() : "";
    const ok = feed?.equals(expected);
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {label}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`font-mono text-xs ${
              !feed
                ? "text-slate-600"
                : ok
                ? "text-emerald-300"
                : "text-amber-300"
            }`}
            title={value || "not set"}
          >
            {feed ? compact(value) : "not set"}
          </span>
          {feed && (
            <button
              onClick={() => copy(kind, value)}
              className="text-[10px] text-sky-400 hover:text-sky-300 transition-colors"
              title="Copy full address"
            >
              {copied === kind ? "✓" : "copy"}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="glass rounded-xl p-3 sm:p-4 border-sky-500/10">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs text-slate-400 uppercase tracking-wider">
          On-chain Pyth Feed Accounts
        </p>
        <span
          className={`text-[10px] font-mono ${
            matches ? "text-emerald-400" : "text-amber-400"
          }`}
        >
          {matches ? "✓ matches expected" : "⚠ check feeds"}
        </span>
      </div>
      <div className="space-y-1.5">
        {row("Feed A (SOL/USD)", feedA ?? undefined, expectedA, "a")}
        {row("Feed B (USDC/USD)", feedB ?? undefined, expectedB, "b")}
      </div>
    </div>
  );
}
