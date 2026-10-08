"use client";

import { useEffect, useState } from "react";
import {
  ORACLE_FEEDS,
  PYTH_SOL_FEED_ID,
  PYTH_USDC_FEED_ID,
  PythPrice,
  fetchHermesPrices,
  toUsd,
} from "@/lib/oracle";

export interface PythPriceState {
  sol: PythPrice | null;
  usdc: PythPrice | null;
  /** Seconds since the oldest feed's publish time. */
  ageSeconds: number | null;
  /** True when the oldest feed is older than 60s (the on-chain window). */
  stale: boolean;
  updatedAt: number | null;
  error: string | null;
}

const REFRESH_MS = 15_000;
const STALE_AFTER_S = 60;

export function usePythPrices(): PythPriceState {
  const [state, setState] = useState<PythPriceState>({
    sol: null,
    usdc: null,
    ageSeconds: null,
    stale: false,
    updatedAt: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const prices = await fetchHermesPrices([
          PYTH_SOL_FEED_ID,
          PYTH_USDC_FEED_ID,
        ]);
        if (cancelled) return;
        const sol = prices[PYTH_SOL_FEED_ID] ?? null;
        const usdc = prices[PYTH_USDC_FEED_ID] ?? null;
        const publish = Math.min(
          sol?.publishTime ?? Number.POSITIVE_INFINITY,
          usdc?.publishTime ?? Number.POSITIVE_INFINITY
        );
        const ageSeconds =
          Number.isFinite(publish) && publish > 0
            ? Math.max(0, Math.floor(Date.now() / 1000) - publish)
            : null;
        setState({
          sol,
          usdc,
          ageSeconds,
          stale: ageSeconds !== null && ageSeconds > STALE_AFTER_S,
          updatedAt: Date.now(),
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState((prev) => ({ ...prev, error: msg }));
      }
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}

/** Format a Pyth price with its confidence interval in USD. */
export function formatUsdPrice(p: PythPrice | null): string {
  if (!p) return "—";
  const usd = toUsd(p);
  const conf = Number(p.conf) * Math.pow(10, p.expo);
  const decimals = usd >= 1000 ? 2 : usd >= 1 ? 3 : 6;
  return `$${usd.toFixed(decimals)} ± $${Math.abs(conf).toFixed(decimals)}`;
}

export function solUsdcRate(
  sol: PythPrice | null,
  usdc: PythPrice | null
): number | null {
  if (!sol || !usdc) return null;
  const solUsd = toUsd(sol);
  const usdcUsd = toUsd(usdc);
  if (!usdcUsd) return null;
  return solUsd / usdcUsd;
}

export { ORACLE_FEEDS };
