"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "@/hooks/use-program";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Keypair, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMint,
  createSyncNativeInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  getStatePda,
  getUserStakePda,
  getStakingPoolPda,
  getRewardVaultPda,
  getPoolPda,
  getPoolTokenPda,
  getPoolLpMintPda,
  getTreasuryPda,
} from "@/lib/pda";

/* ─── CONSTANTS ──────────────────────────────────────── */
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT_KEY = "defi_usdc_mint";
let USDC_MINT = (() => {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(USDC_MINT_KEY) : null;
    if (saved) return new PublicKey(saved);
  } catch {}
  return PublicKey.default;
})();

type TokenType = 0 | 1;
type TabId = "stake" | "unstake" | "claim" | "swap" | "pool" | "liquidity" | "admin";
type TxStatus = "idle" | "sending" | "confirmed" | "error";

const TOKEN_LABELS: Record<TokenType, string> = { 0: "SOL", 1: "USDC" };
const TOKEN_DECIMALS: Record<TokenType, number> = { 0: 9, 1: 6 };
const MIN_STAKE: Record<TokenType, string> = { 0: "1 SOL", 1: "1,000 USDC" };

/* ─── FRIENDLY ERROR MAP ─────────────────────────────── */
const FRIENDLY_ERRORS: Record<number, string> = {
  0xbc4: "Account not initialized. The program state hasn't been set up yet. An admin must call initialize_state first.",
  6000: "Math overflow.",
  6001: "Math underflow.",
  6002: "Unauthorized. Your wallet is not authorized for this action.",
  6003: "Program is paused.",
  6004: "Not in emergency mode.",
  6005: "Invalid amount.",
  6006: "Insufficient balance.",
  6007: "Slippage tolerance exceeded.",
  6008: "Non-proportional liquidity. Token A and B amounts must match the pool ratio.",
  6009: "Invariant violation.",
  6010: "Invalid mint order for pool.",
  6011: "No rewards to claim.",
  6012: "Stake account not empty.",
  6013: "Insufficient liquidity.",
  6014: "Insufficient stake amount.",
  6015: "Amount below minimum.",
  6016: "Swap amount too large for pool stability.",
  6017: "Fee out of valid range.",
  6018: "Invalid mint.",
  6019: "Insufficient signatures for multi-sig.",
  6020: "Invalid action for timelock.",
  6021: "Timelock delay not expired.",
  6022: "Invalid token type. Must be 0 (SOL) or 1 (USDC).",
  6023: "A proposal is already active.",
  6024: "Flash loan not repaid.",
  6025: "Flash loan too large (max 50% of pool).",
  6026: "Invalid callback program.",
  6027: "Callback program not approved.",
};

/* ─── ERROR PARSER ───────────────────────────────────── */
function parseErrorMessage(err: unknown): string {
  if (!err) return "Unknown error.";
  if (typeof err === "string") return err;
  const e = err as Record<string, unknown>;

  if (e.logs && Array.isArray(e.logs)) {
    const logs = e.logs as string[];
    for (const log of logs) {
      if (log.includes("Error Message:")) {
        const m = log.match(/Error Message:\s*(.+?)(?:\.?\s*Program|$)/);
        if (m) return m[1].trim();
      }
      if (log.includes("Error Code:")) {
        const c = log.match(/Error Code:\s*(.+?)(?:\.|$)/);
        if (c) {
          const code = c[1].trim();
          if (code === "AccountNotInitialized") return FRIENDLY_ERRORS[0xbc4];
          if (code === "ConstraintHasOne") return "Not authorized — this wallet is not the registered authority.";
          if (code === "ConstraintSeeds") return "Account address mismatch — PDA derivation may be wrong.";
          if (code === "ConstraintSigner") return "Missing signer — approve the transaction in your wallet.";
          if (code === "AccountOwnedByWrongProgram") return "Account owned by wrong program — may not be initialized.";
          return code;
        }
      }
      if (log.includes("custom program error:")) {
        const m = log.match(/custom program error:\s*(0x[0-9a-fA-F]+)/);
        if (m) {
          const code = parseInt(m[1], 16);
          return FRIENDLY_ERRORS[code] || `Program error ${m[1]}.`;
        }
      }
    }
    const last = logs.slice(-3).join(" → ");
    if (last) return `Transaction reverted. Logs: ${last.slice(0, 200)}`;
  }

  if (e.message && typeof e.message === "string") {
    const msg = e.message as string;
    if (msg.includes("User rejected")) return "Cancelled — you declined in your wallet.";
    if (msg.includes("Blockhash not found")) return "Network delay — blockhash expired before signing. The network is busy or the wallet took too long. Please try again.";
    if (msg.includes("block height exceeded")) return "Transaction expired — the network advanced while waiting for your signature. Please try again.";
    if (msg.includes("SendTransactionError")) return "Transaction simulation failed. This usually means one of the accounts isn't set up yet (e.g., pool not created, token account missing). Try again.";
    if (msg.includes("insufficient lamports")) return "Insufficient SOL in your wallet. Get devnet SOL from faucet.solana.com. Note: funding the SOL vault requires wrapping SOL to WSOL first — make sure you have enough SOL.";
    if (msg.includes("0x1")) return "Insufficient funds. For SOL vault: you need enough native SOL + the WSOL token account must be funded. For USDC vault: you need USDC tokens in your wallet.";
    if (msg.includes("insufficient funds")) return "Insufficient token balance in your wallet or token account.";
    if (msg.includes("Attempt to debit an account but found no record")) return "Token account not found. Create an ATA first.";
    if (msg.includes("Attempt to load a program that does not exist")) return "Program not on-chain. Is it deployed to devnet?";
    if (msg.includes("Simulation failed")) return "Transaction reverted during simulation. Common causes: pool not created, account not initialized, or insufficient balance. Check the Pool tab to verify pool exists.";
    return msg.slice(0, 300);
  }
  if (typeof e === "object" && e !== null) {
    // Handle SendTransactionError with getLogs
    const obj = e as Record<string, unknown>;
    if (typeof (obj as any).getLogs === "function") {
      try {
        const logs = (obj as any).getLogs() as string[];
        if (logs && logs.length) {
          const last = logs.slice(-5).join(" → ");
          return `Simulation failed. Logs: ${last.slice(0, 200)}`;
        }
      } catch {}
    }
    if (obj.message && typeof obj.message === "string") {
      return (obj.message as string).slice(0, 300);
    }
  }
  return "Unexpected error. Please try again or check browser console for details.";
}

/* ─── COMPONENT ──────────────────────────────────────── */
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
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gradient tracking-tight">Solana DeFi Protocol</h2>
            <p className="text-slate-400 text-sm max-w-md mx-auto leading-relaxed">Connecting to wallet...</p>
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

/* ─── WELCOME ────────────────────────────────────────── */
function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] sm:min-h-[70vh] text-center animate-fade-in">
      <div className="glass glow rounded-2xl sm:rounded-3xl p-6 sm:p-10 md:p-14 max-w-2xl w-full mx-2 sm:mx-0 space-y-5 sm:space-y-6">
        <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center shadow-xl shadow-sky-500/20">
          <span className="text-white text-2xl sm:text-3xl font-bold">D</span>
        </div>
        <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gradient tracking-tight">Solana DeFi Protocol</h2>
        <p className="text-slate-400 text-sm sm:text-base max-w-md mx-auto leading-relaxed">
          A production-grade decentralized finance protocol featuring{" "}
          <strong>multi-signature governance</strong>,{" "}
          <strong>yield-bearing staking pools</strong> (SOL & USDC), an{" "}
          <strong>automated market maker</strong> with flash loan support, and
          emergency safety mechanisms — running on Solana Devnet.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 text-left mt-4 sm:mt-6">
          <FC emoji="🔐" title="Multi-Sig Admin" desc="3-of-3 signer governance with timelock" />
          <FC emoji="💧" title="Liquidity Pools" desc="Constant-product AMM with flash loans" />
          <FC emoji="🏆" title="Staking Rewards" desc="Stake SOL or USDC to earn yield" />
        </div>
        <div className="pt-2 sm:pt-4"><WalletMultiButton /></div>
      </div>
    </div>
  );
}
function FC({ emoji, title, desc }: { emoji: string; title: string; desc: string }) {
  return (
    <div className="glass rounded-xl p-3 sm:p-4 border-sky-500/10">
      <div className="text-xl sm:text-2xl mb-1">{emoji}</div>
      <h3 className="font-semibold text-xs sm:text-sm text-sky-300">{title}</h3>
      <p className="text-xs text-slate-500 mt-1 leading-relaxed">{desc}</p>
    </div>
  );
}

/* ─── USER PORTFOLIO ─────────────────────────────────── */
function UserPortfolio({ provider }: { provider: any }) {
  const { publicKey: pk } = useWallet();
  const [stakedSol, setStakedSol] = useState<string | null>(null);
  const [pendingRewardsSol, setPendingRewardsSol] = useState<string | null>(null);
  const [stakedUsdc, setStakedUsdc] = useState<string | null>(null);
  const [pendingRewardsUsdc, setPendingRewardsUsdc] = useState<string | null>(null);
  const [lpBal, setLpBal] = useState<string | null>(null);
  const [lpShare, setLpShare] = useState<string | null>(null);

  useEffect(() => {
    if (!provider || !pk) return;
    const conn = provider.connection;
    (async () => {
      // SOL stake
      try {
        const [solPda] = getUserStakePda(pk, 0);
        const info = await conn.getAccountInfo(solPda);
        if (info && info.data.length >= 8 + 72) {
          const dv = new DataView(info.data.buffer, info.data.byteOffset + 8, info.data.length - 8);
          setStakedSol((Number(dv.getBigUint64(32, true)) / 1e9).toFixed(4));
          setPendingRewardsSol((Number(dv.getBigUint64(56, true)) / 1e9).toFixed(6));
        } else { setStakedSol("0"); setPendingRewardsSol("0"); }
      } catch { setStakedSol(null); setPendingRewardsSol(null); }
      // USDC stake
      try {
        const [usdcPda] = getUserStakePda(pk, 1);
        const info = await conn.getAccountInfo(usdcPda);
        if (info && info.data.length >= 8 + 72) {
          const dv = new DataView(info.data.buffer, info.data.byteOffset + 8, info.data.length - 8);
          setStakedUsdc((Number(dv.getBigUint64(32, true)) / 1e6).toFixed(2));
          setPendingRewardsUsdc((Number(dv.getBigUint64(56, true)) / 1e9).toFixed(6));
        } else { setStakedUsdc("0"); setPendingRewardsUsdc("0"); }
      } catch { setStakedUsdc(null); setPendingRewardsUsdc(null); }
      // LP position
      try {
        const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
        const [lpMint] = getPoolLpMintPda(poolPda);
        const ata = getAssociatedTokenAddressSync(lpMint, pk);
        const info = await conn.getAccountInfo(ata);
        if (info && info.data.length >= 72) {
          const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setLpBal((Number(bal) / 1e9).toFixed(6));
          const mintInfo = await conn.getAccountInfo(lpMint);
          if (mintInfo && mintInfo.data.length >= 44) {
            const supply = new DataView(mintInfo.data.buffer, mintInfo.data.byteOffset + 36, 8).getBigUint64(0, true);
            if (supply > BigInt(0)) {
              const share = Number(bal) / Number(supply) * 100;
              setLpShare(share < 0.01 ? "<0.01" : share.toFixed(2));
            } else setLpShare("0");
          }
        } else { setLpBal("0"); setLpShare("0"); }
      } catch { setLpBal(null); setLpShare(null); }
    })();
  }, [provider, pk]);

  return (
    <div className="rounded-xl border border-emerald-500/10 overflow-hidden">
      <div className="p-2 sm:p-3 bg-emerald-500/5 border-b border-emerald-500/10">
        <h4 className="text-xs font-semibold text-emerald-400 flex items-center gap-2">
          <span>📊</span> My Portfolio
        </h4>
      </div>
      <div className="p-2 sm:p-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
        <KV label="Staked SOL" value={stakedSol !== null ? `${stakedSol} SOL` : "—"} />
        <KV label="SOL Rewards" value={pendingRewardsSol !== null ? `${pendingRewardsSol} SOL` : "—"} accent={pendingRewardsSol && parseFloat(pendingRewardsSol) > 0 ? "text-amber-300" : undefined} />
        <KV label="Staked USDC" value={stakedUsdc !== null ? `${stakedUsdc} USDC` : "—"} />
        <KV label="USDC Rewards" value={pendingRewardsUsdc !== null ? `${pendingRewardsUsdc} SOL` : "—"} accent={pendingRewardsUsdc && parseFloat(pendingRewardsUsdc) > 0 ? "text-amber-300" : undefined} />
        <KV label="LP Tokens" value={lpBal !== null ? `${lpBal} LP` : "—"} />
        <KV label="Pool Share" value={lpShare !== null ? `${lpShare}%` : "—"} />
      </div>
    </div>
  );
}

/* ─── DASHBOARD ──────────────────────────────────────── */
function Dashboard() {
  const { publicKey: walletPk } = useWallet();
  const { program, provider } = useProgram();
  const [tab, setTab] = useState<TabId>("stake");
  const [isAdmin, setIsAdmin] = useState(false);

  const tabs: { id: TabId; label: string; icon: string; adminOnly?: boolean }[] = [
    { id: "stake", label: "Stake", icon: "📥" },
    { id: "unstake", label: "Unstake", icon: "📤" },
    { id: "claim", label: "Claim", icon: "🎁" },
    { id: "swap", label: "Swap", icon: "🔄" },
    { id: "pool", label: "Pool", icon: "📊" },
    { id: "liquidity", label: "Liquidity", icon: "💧" },
    { id: "admin", label: "Admin", icon: "⚙️", adminOnly: true },
  ];
  const visible = tabs.filter((t) => !t.adminOnly || (isAdmin && t.adminOnly));
  const base58 = walletPk?.toBase58() ?? "";

  return (
    <div className="space-y-4 sm:space-y-6 animate-fade-in">
      {/* ─── MY PORTFOLIO ─── */}
      <UserPortfolio provider={provider} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-gradient tracking-tight">Dashboard</h2>
          <p className="text-slate-500 text-xs sm:text-sm mt-0.5 break-all">
            <span className="font-mono text-sky-400 text-xs sm:text-sm">
              {base58.slice(0, 4)}..{base58.slice(-3)}
            </span>
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
          <span className="text-xs text-slate-500">Admin Mode</span>
          <button onClick={() => setIsAdmin(!isAdmin)}
            className={`relative w-11 h-6 rounded-full transition-colors ${isAdmin ? "bg-amber-500" : "bg-slate-700"}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${isAdmin ? "translate-x-5" : ""}`} />
          </button>
        </label>
      </div>
      <div className="flex gap-1.5 sm:gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {visible.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`shrink-0 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${
              tab === t.id ? "bg-sky-500/20 border border-sky-400/40 text-sky-300 shadow-lg shadow-sky-500/10" : "glass text-slate-400 hover:text-slate-200 hover:border-sky-500/20"
            }`}>
            <span className="mr-1 sm:mr-1.5">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="glass glow rounded-xl sm:rounded-2xl p-4 sm:p-6 md:p-8">
        {tab === "stake" && <StakePanel program={program} provider={provider} />}
        {tab === "unstake" && <UnstakePanel program={program} provider={provider} />}
        {tab === "claim" && <ClaimPanel program={program} provider={provider} />}
        {tab === "swap" && <SwapPanel program={program} provider={provider} />}
        {tab === "pool" && <PoolInfoPanel program={program} provider={provider} />}
        {tab === "liquidity" && <LiquidityPanel program={program} provider={provider} />}
        {tab === "admin" && <AdminPanel program={program} provider={provider} />}
      </div>
    </div>
  );
}

/* ─── REUSABLE UI ────────────────────────────────────── */
function TS({ value, onChange }: { value: TokenType; onChange: (t: TokenType) => void }) {
  return (
    <div className="flex gap-2">
      {([0, 1] as TokenType[]).map((t) => (
        <button key={t} onClick={() => onChange(t)}
          className={`px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            value === t ? "bg-sky-500/20 border border-sky-400/40 text-sky-300" : "glass text-slate-500 hover:text-slate-300"
          }`}>{TOKEN_LABELS[t]}</button>
      ))}
    </div>
  );
}

function ABtn({ label, onClick, status, disabled }: { label: string; onClick: () => void; status: TxStatus; disabled?: boolean }) {
  const loading = status === "sending";
  return (
    <button onClick={onClick} disabled={disabled || loading}
      className="w-full py-2.5 sm:py-3 rounded-xl font-semibold text-xs sm:text-sm transition-all bg-gradient-to-r from-sky-500 to-indigo-500 text-white hover:from-sky-400 hover:to-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-sky-500/20">
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>Sending...
        </span>
      ) : status === "confirmed" ? "✓ Confirmed" : label}
    </button>
  );
}

function Err({ message }: { message: string }) {
  if (!message) return null;
  return <div className="p-3 sm:p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs sm:text-sm animate-fade-in break-words"><span className="font-semibold">Error: </span>{message}</div>;
}
function Ok({ message }: { message: string }) {
  if (!message) return null;
  return <div className="p-3 sm:p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs sm:text-sm animate-fade-in break-words">{message}</div>;
}

function Inp({ label, val, set, ph }: { label: string; val: string; set: (v: string) => void; ph?: string }) {
  return (
    <div>
      <label className="text-xs text-slate-400 uppercase tracking-wider block mb-1.5">{label}</label>
      <input type="number" step="any" min="0" placeholder={ph ?? "0.0"} value={val} onChange={(e) => set(e.target.value)}
        className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl glass border border-sky-500/10 focus:border-sky-400/40 focus:outline-none focus:ring-2 focus:ring-sky-500/10 text-slate-200 placeholder:text-slate-600 font-mono text-sm" />
    </div>
  );
}

function InpTxt({ label, val, set, ph }: { label: string; val: string; set: (v: string) => void; ph?: string }) {
  return (
    <div>
      <label className="text-xs text-slate-400 uppercase tracking-wider block mb-1.5">{label}</label>
      <input type="text" placeholder={ph ?? ""} value={val} onChange={(e) => set(e.target.value)}
        className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl glass border border-sky-500/10 focus:border-sky-400/40 focus:outline-none focus:ring-2 focus:ring-sky-500/10 text-slate-200 placeholder:text-slate-600 font-mono text-sm" />
    </div>
  );
}

/* ─── STAKE ──────────────────────────────────────────── */
function StakePanel({ program, provider }: { program: any; provider: any }) {
  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">Stake Tokens</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Deposit SOL or USDC to earn rewards. Each pool operates independently.</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <SolStakeCard program={program} provider={provider} />
        <UsdcStakeCard program={program} provider={provider} />
      </div>
    </div>
  );
}

function SolStakeCard({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [amt, setAmt] = useState("");
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [poolBal, setPoolBal] = useState<string | null>(null);
  const tt = 0 as TokenType;

  useEffect(() => {
    if (!provider) return;
    (async () => {
      try {
        const [stp] = getStakingPoolPda(tt);
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(raw) / 1e9).toFixed(4)} SOL`);
        } else { setPoolBal("0 SOL"); }
      } catch { setPoolBal(null); }
    })();
  }, [provider]);

  const run = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const p = parseFloat(amt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount.");
      const lamports = Math.floor(p * LAMPORTS_PER_SOL);
      if (lamports < LAMPORTS_PER_SOL) throw new Error("Minimum: 1 SOL.");
      const raw = new BN(lamports);
      const conn = provider.connection;
      const ata = getAssociatedTokenAddressSync(WSOL_MINT, pk);

      // Auto-wrap: ensure WSOL ATA exists and has enough balance
      const ataInfo = await conn.getAccountInfo(ata);
      if (!ataInfo) {
        const { blockhash: bh } = await conn.getLatestBlockhash();
        const ix = createAssociatedTokenAccountInstruction(pk, ata, pk, WSOL_MINT);
        const ctrx = new Transaction().add(ix); ctrx.feePayer = pk; ctrx.recentBlockhash = bh;
        await provider.sendAndConfirm(ctrx, []);
      }
      const postAta = await conn.getAccountInfo(ata);
      const wsolBal = postAta && postAta.data.length >= 72
        ? new DataView(postAta.data.buffer, postAta.data.byteOffset + 64, 8).getBigUint64(0, true)
        : BigInt(0);
      if (wsolBal < BigInt(lamports)) {
        const wrapNeeded = BigInt(lamports) - wsolBal;
        const { blockhash: bh2 } = await conn.getLatestBlockhash();
        const wrapTx = new Transaction()
          .add(SystemProgram.transfer({ fromPubkey: pk, toPubkey: ata, lamports: Number(wrapNeeded) }))
          .add(createSyncNativeInstruction(ata));
        wrapTx.feePayer = pk; wrapTx.recentBlockhash = bh2;
        await provider.sendAndConfirm(wrapTx, []);
      }

      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tt);
      const [stp] = getStakingPoolPda(tt);
      const tx = await program.methods.stake(raw, tt).accounts({
        user: pk, userTokenAccount: ata, stakingPool: stp,
        state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();
      setS("confirmed"); setOk(`Staked ${amt} SOL! TX: ${tx.slice(0, 12)}...`); setAmt("");
      try {
        const info = await conn.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(bal) / 1e9).toFixed(4)} SOL`);
        }
      } catch {}
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amt]);

  return (
    <div className="glass rounded-xl p-4 border-sky-500/10 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">☀️</span>
        <h4 className="text-sm font-semibold text-sky-300">Stake SOL</h4>
      </div>
      <p className="text-xs text-slate-500">SOL auto-wraps to WSOL. Minimum: 1 SOL.</p>
      <div className="p-2 rounded-lg bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs font-mono">
        Pool: {poolBal ?? "..."}
      </div>
      <Inp label="Amount (SOL)" val={amt} set={setAmt} ph="1.0" />
      <ABtn label="Stake SOL" onClick={run} status={s} disabled={!amt} />
      <Err message={err} /><Ok message={ok} />
    </div>
  );
}

function UsdcStakeCard({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [amt, setAmt] = useState("");
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [poolBal, setPoolBal] = useState<string | null>(null);
  const tt = 1 as TokenType;

  useEffect(() => {
    if (!provider) return;
    (async () => {
      try {
        const [stp] = getStakingPoolPda(tt);
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(raw) / 1e6).toFixed(2)} USDC`);
        } else { setPoolBal("0 USDC"); }
      } catch { setPoolBal(null); }
    })();
  }, [provider]);

  const run = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const p = parseFloat(amt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount.");
      const rawAmount = Math.floor(p * 1_000_000);
      if (rawAmount < 1_000_000_000) throw new Error("Minimum: 1,000 USDC (contract-enforced).");
      const raw = new BN(rawAmount);
      const ata = getAssociatedTokenAddressSync(USDC_MINT, pk);
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tt);
      const [stp] = getStakingPoolPda(tt);
      const tx = await program.methods.stake(raw, tt).accounts({
        user: pk, userTokenAccount: ata, stakingPool: stp,
        state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();
      setS("confirmed"); setOk(`Staked ${amt} USDC! TX: ${tx.slice(0, 12)}...`); setAmt("");
      try {
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(bal) / 1e6).toFixed(2)} USDC`);
        }
      } catch {}
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amt]);

  return (
    <div className="glass rounded-xl p-4 border-sky-500/10 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">💵</span>
        <h4 className="text-sm font-semibold text-sky-300">Stake USDC</h4>
      </div>
      <p className="text-xs text-slate-500">Requires USDC tokens in your wallet. Minimum: 1,000 USDC.</p>
      <div className="p-2 rounded-lg bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs font-mono">
        Pool: {poolBal ?? "..."}
      </div>
      <Inp label="Amount (USDC)" val={amt} set={setAmt} ph="1000" />
      <ABtn label="Stake USDC" onClick={run} status={s} disabled={!amt} />
      <Err message={err} /><Ok message={ok} />
    </div>
  );
}

/* ─── UNSTAKE ────────────────────────────────────────── */
function UnstakePanel({ program, provider }: { program: any; provider: any }) {
  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">Unstake Tokens</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Withdraw staked tokens from either pool. Rewards update automatically.</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <SolUnstakeCard program={program} provider={provider} />
        <UsdcUnstakeCard program={program} provider={provider} />
      </div>
    </div>
  );
}

function SolUnstakeCard({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [amt, setAmt] = useState("");
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [poolBal, setPoolBal] = useState<string | null>(null);
  const tt = 0 as TokenType;

  useEffect(() => {
    if (!provider) return;
    (async () => {
      try {
        const [stp] = getStakingPoolPda(tt);
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(raw) / 1e9).toFixed(4)} SOL`);
        } else { setPoolBal("0 SOL"); }
      } catch { setPoolBal(null); }
    })();
  }, [provider]);

  const run = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const p = parseFloat(amt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount.");
      const raw = new BN(Math.floor(p * LAMPORTS_PER_SOL));
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tt);
      const [stp] = getStakingPoolPda(tt);
      const ata = getAssociatedTokenAddressSync(WSOL_MINT, pk);
      const tx = await program.methods.unstake(raw, tt).accounts({
        user: pk, userTokenAccount: ata, stakingPool: stp,
        state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setS("confirmed"); setOk(`Unstaked ${amt} SOL! TX: ${tx.slice(0, 12)}...`); setAmt("");
      try {
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(bal) / 1e9).toFixed(4)} SOL`);
        }
      } catch {}
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amt]);

  return (
    <div className="glass rounded-xl p-4 border-sky-500/10 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">☀️</span>
        <h4 className="text-sm font-semibold text-sky-300">Unstake SOL</h4>
      </div>
      <p className="text-xs text-slate-500">Withdraw SOL back to WSOL (unwrap manually if needed).</p>
      <div className="p-2 rounded-lg bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs font-mono">
        Pool: {poolBal ?? "..."}
      </div>
      <Inp label="Amount (SOL)" val={amt} set={setAmt} ph="0.0" />
      <ABtn label="Unstake SOL" onClick={run} status={s} disabled={!amt} />
      <div className="pt-2 border-t border-sky-500/10">
        <p className="text-xs text-amber-400/80 mb-2">⚠️ Emergency: Unstake all SOL when protocol is paused.</p>
        <ABtn label="Emergency Unstake SOL" onClick={async () => {
          if (!program || !provider || !pk) return;
          setErr(""); setOk(""); setS("sending");
          try {
            const [sp] = getStatePda();
            const [usp] = getUserStakePda(pk, tt);
            const [stp] = getStakingPoolPda(tt);
            const ata = getAssociatedTokenAddressSync(WSOL_MINT, pk);
            const tx = await program.methods.emergencyUnstake(tt).accounts({
              user: pk, userTokenAccount: ata, stakingPool: stp,
              state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
            }).rpc();
            setS("confirmed"); setOk(`Emergency unstaked SOL! TX: ${tx.slice(0, 12)}...`);
            try { const info = await provider.connection.getAccountInfo(stp);
              if (info && info.data.length >= 72) { const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
              setPoolBal(`${(Number(bal) / 1e9).toFixed(4)} SOL`); } } catch {}
          } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
        }} status={s} />
      </div>
      <Err message={err} /><Ok message={ok} />
    </div>
  );
}

function UsdcUnstakeCard({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [amt, setAmt] = useState("");
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [poolBal, setPoolBal] = useState<string | null>(null);
  const tt = 1 as TokenType;

  useEffect(() => {
    if (!provider) return;
    (async () => {
      try {
        const [stp] = getStakingPoolPda(tt);
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(raw) / 1e6).toFixed(2)} USDC`);
        } else { setPoolBal("0 USDC"); }
      } catch { setPoolBal(null); }
    })();
  }, [provider]);

  const run = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const p = parseFloat(amt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount.");
      const raw = new BN(Math.floor(p * 1_000_000));
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tt);
      const [stp] = getStakingPoolPda(tt);
      const ata = getAssociatedTokenAddressSync(USDC_MINT, pk);
      const tx = await program.methods.unstake(raw, tt).accounts({
        user: pk, userTokenAccount: ata, stakingPool: stp,
        state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setS("confirmed"); setOk(`Unstaked ${amt} USDC! TX: ${tx.slice(0, 12)}...`); setAmt("");
      try {
        const info = await provider.connection.getAccountInfo(stp);
        if (info && info.data.length >= 72) {
          const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolBal(`${(Number(bal) / 1e6).toFixed(2)} USDC`);
        }
      } catch {}
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amt]);

  return (
    <div className="glass rounded-xl p-4 border-sky-500/10 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">💵</span>
        <h4 className="text-sm font-semibold text-sky-300">Unstake USDC</h4>
      </div>
      <p className="text-xs text-slate-500">Withdraw USDC tokens back to your wallet.</p>
      <div className="p-2 rounded-lg bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs font-mono">
        Pool: {poolBal ?? "..."}
      </div>
      <Inp label="Amount (USDC)" val={amt} set={setAmt} ph="0.0" />
      <ABtn label="Unstake USDC" onClick={run} status={s} disabled={!amt} />
      <div className="pt-2 border-t border-sky-500/10">
        <p className="text-xs text-amber-400/80 mb-2">⚠️ Emergency: Unstake all USDC when protocol is paused.</p>
        <ABtn label="Emergency Unstake USDC" onClick={async () => {
          if (!program || !provider || !pk) return;
          setErr(""); setOk(""); setS("sending");
          try {
            const [sp] = getStatePda();
            const [usp] = getUserStakePda(pk, tt);
            const [stp] = getStakingPoolPda(tt);
            const ata = getAssociatedTokenAddressSync(USDC_MINT, pk);
            const tx = await program.methods.emergencyUnstake(tt).accounts({
              user: pk, userTokenAccount: ata, stakingPool: stp,
              state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
            }).rpc();
            setS("confirmed"); setOk(`Emergency unstaked USDC! TX: ${tx.slice(0, 12)}...`);
            try { const info = await provider.connection.getAccountInfo(stp);
              if (info && info.data.length >= 72) { const bal = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
              setPoolBal(`${(Number(bal) / 1e6).toFixed(2)} USDC`); } } catch {}
          } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
        }} status={s} />
      </div>
      <Err message={err} /><Ok message={ok} />
    </div>
  );
}

/* ─── CLAIM ──────────────────────────────────────────── */
function ClaimPanel({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [tt, setTt] = useState<TokenType>(0);
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [vaultBal, setVaultBal] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    (async () => {
      try {
        const [rv] = getRewardVaultPda(tt);
        const info = await provider.connection.getAccountInfo(rv);
        if (info && info.data.length >= 72) {
          const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          const div = tt === 0 ? 1e9 : 1e6;
          setVaultBal(`${(Number(raw) / div).toFixed(tt === 0 ? 4 : 2)} ${TOKEN_LABELS[tt]}`);
        } else { setVaultBal(`0 ${TOKEN_LABELS[tt]}`); }
      } catch { setVaultBal(null); }
    })();
  }, [provider, tt]);

  const run = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const [sp] = getStatePda();
      const [usp] = getUserStakePda(pk, tt);
      const [rvs] = getRewardVaultPda(0);
      const [rvu] = getRewardVaultPda(1);
      const mint = tt === 0 ? WSOL_MINT : USDC_MINT;
      const ata = getAssociatedTokenAddressSync(mint, pk);
      const tx = await program.methods.claimRewards(tt).accounts({
        user: pk, userRewardTokenAccount: ata,
        rewardVaultSol: rvs, rewardVaultUsdc: rvu,
        state: sp, userStake: usp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setS("confirmed"); setOk(`Rewards claimed! TX: ${tx.slice(0, 12)}...`);
      // Refresh vault balance after claiming
      try {
        const [rv] = getRewardVaultPda(tt);
        const info = await provider.connection.getAccountInfo(rv);
        if (info && info.data.length >= 72) {
          const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
          const div = tt === 0 ? 1e9 : 1e6;
          setVaultBal(`${(Number(raw) / div).toFixed(tt === 0 ? 4 : 2)} ${TOKEN_LABELS[tt]}`);
        }
      } catch {}
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, tt]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">Claim Rewards</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Collect accrued staking rewards and manage your stake accounts.</p>
      </div>
      <TS value={tt} onChange={setTt} />
      <div className="p-2 rounded-lg bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs font-mono">
        Vault Balance: {vaultBal ?? "..."} {TOKEN_LABELS[tt]}
      </div>
      <ABtn label="Claim Rewards" onClick={run} status={s} />
      <div className="flex gap-2">
        <button onClick={async () => {
          if (!program || !provider || !pk) return;
          setErr(""); setOk(""); setS("sending");
          try {
            const [sp] = getStatePda();
            const [usp] = getUserStakePda(pk, tt);
            const tx = await program.methods.updateRewards(tt).accounts({
              user: pk, state: sp, userStake: usp,
            }).rpc();
            setS("confirmed"); setOk(`Rewards updated! TX: ${tx.slice(0, 12)}...`);
          } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
        }} disabled={s === "sending"}
          className="flex-1 py-2 rounded-xl text-xs font-semibold bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 transition-all disabled:opacity-40">
          🔄 Update Rewards
        </button>
        <button onClick={async () => {
          if (!program || !provider || !pk) return;
          setErr(""); setOk(""); setS("sending");
          try {
            const [usp] = getUserStakePda(pk, tt);
            const tx = await program.methods.closeStakeAccount(tt).accounts({
              user: pk, userStake: usp,
            }).rpc();
            setS("confirmed"); setOk(`Stake account closed! TX: ${tx.slice(0, 12)}...`);
          } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
        }} disabled={s === "sending"}
          className="flex-1 py-2 rounded-xl text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-40">
          🗑️ Close Account
        </button>
      </div>
      <Err message={err} /><Ok message={ok} />
    </div>
  );
}

/* ─── SWAP ───────────────────────────────────────────── */
function SwapPanel({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [amtIn, setAmtIn] = useState("");
  const [slippage, setSlippage] = useState("1"); // default 1% slippage
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const run = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const pIn = parseFloat(amtIn);
      const slp = parseFloat(slippage);
      if (isNaN(pIn) || pIn <= 0) throw new Error("Enter a valid input amount.");
      if (isNaN(slp) || slp < 0) throw new Error("Enter a valid slippage.");

      // Auto-calculate min output: amount_in * 0.99 (1% slippage by default)
      const estimatedOut = pIn * (1 - slp / 100);
      const rawIn = new BN(Math.floor(pIn * LAMPORTS_PER_SOL));
      const rawOut = new BN(Math.floor(Math.max(0, estimatedOut) * 1_000_000));

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const userInAta = getAssociatedTokenAddressSync(WSOL_MINT, pk);
      const userOutAta = getAssociatedTokenAddressSync(USDC_MINT, pk);

      const tx = await program.methods.swap(rawIn, rawOut).accounts({
        user: pk, userTokenIn: userInAta, userTokenOut: userOutAta,
        pool: poolPda, poolTokenA, poolTokenB,
        tokenIn: WSOL_MINT, tokenOut: USDC_MINT,
        state: sp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setS("confirmed"); setOk(`Swap executed! TX: ${tx.slice(0, 12)}...`);
      setAmtIn("");
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amtIn, slippage]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">Swap Tokens</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Swap SOL → USDC via the AMM pool.</p>
      </div>
      <Inp label="Amount In (SOL)" val={amtIn} set={setAmtIn} ph="0.0" />
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <label className="text-xs text-slate-400 uppercase tracking-wider">Slippage Tolerance (%)</label>
          <span className="text-[10px] text-slate-600 cursor-help" title="Slippage = max price change you accept. Lower = safer but may revert. Higher = more likely to succeed. You set this — typically 0.5-3%.">ⓘ what's this?</span>
        </div>
        <div className="flex gap-2">
          {["0.5", "1", "3"].map((v) => (
            <button key={v} onClick={() => setSlippage(v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                slippage === v ? "bg-sky-500/20 border border-sky-400/40 text-sky-300" : "glass text-slate-500 hover:text-slate-300"
              }`}>{v}%</button>
          ))}
          <input type="number" step="0.1" min="0" max="50" value={slippage} onChange={(e) => setSlippage(e.target.value)}
            className="w-20 px-2 py-1.5 rounded-lg glass border border-sky-500/10 text-slate-200 text-xs font-mono focus:border-sky-400/40 focus:outline-none" />
          <span className="text-xs text-slate-500 self-center">%</span>
        </div>
        {amtIn && !isNaN(parseFloat(amtIn)) && (
          <p className="text-[10px] text-slate-600 mt-1">
            Min output: ~{(parseFloat(amtIn) * (1 - parseFloat(slippage || "1") / 100)).toFixed(2)} USDC
          </p>
        )}
      </div>
      <ABtn label="Swap SOL → USDC" onClick={run} status={s} disabled={!amtIn} />
      <Err message={err} /><Ok message={ok} />
    </div>
  );
}

/* ─── POOL INFO ──────────────────────────────────────── */
function PoolInfoPanel({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [amt, setAmt] = useState("");
  const [cbProgram, setCbProgram] = useState("");
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // Read pool on-chain data
  const [poolFee, setPoolFee] = useState<string | null>(null);
  const [poolFlashFee, setPoolFlashFee] = useState<string | null>(null);
  const [poolSolBal, setPoolSolBal] = useState<string | null>(null);
  const [poolUsdcBal, setPoolUsdcBal] = useState<string | null>(null);
  const [poolLpMintAddr, setPoolLpMintAddr] = useState<string | null>(null);
  const [approvedCbProgram, setApprovedCbProgram] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    (async () => {
      const conn = provider.connection;
      try {
        const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
        const info = await conn.getAccountInfo(poolPda);
        if (info && info.data.length >= 8) {
          const dv = new DataView(info.data.buffer, info.data.byteOffset, info.data.length);
          let offset = 8 + 1; // discriminator + bump
          // skip token_a_mint (32) + token_b_mint (32) + token_a_account (32) + token_b_account (32) + lp_token_mint (32)
          offset += 32 * 5;
          const fee = dv.getUint16(offset, true); offset += 2;
          setPoolFee(`${fee} bps (${(fee / 100).toFixed(2)}%)`);
          offset += 16; // skip k_last (u128)
          const ff = dv.getUint16(offset, true); offset += 2;
          setPoolFlashFee(`${ff} bps (${(ff / 100).toFixed(2)}%)`);
        } else {
          setPoolFee("Pool not created yet");
        }
      } catch { setPoolFee(null); }
      try {
        const [lpMint] = getPoolLpMintPda((getPoolPda(WSOL_MINT, USDC_MINT)[0]));
        setPoolLpMintAddr(`${lpMint.toBase58().slice(0, 8)}...`);
      } catch { setPoolLpMintAddr(null); }
      try {
        const [poolPda2] = getPoolPda(WSOL_MINT, USDC_MINT);
        const [poolTokenA] = getPoolTokenPda(poolPda2, "token_a");
        const infoA = await conn.getAccountInfo(poolTokenA);
        if (infoA && infoA.data.length >= 72) {
          const bal = new DataView(infoA.data.buffer, infoA.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolSolBal(`${(Number(bal) / 1e9).toFixed(4)} SOL`);
        }
        const [poolTokenB] = getPoolTokenPda(poolPda2, "token_b");
        const infoB = await conn.getAccountInfo(poolTokenB);
        if (infoB && infoB.data.length >= 72) {
          const bal = new DataView(infoB.data.buffer, infoB.data.byteOffset + 64, 8).getBigUint64(0, true);
          setPoolUsdcBal(`${(Number(bal) / 1e6).toFixed(2)} USDC`);
        }
      } catch {}
      try {
        // Read approved callback program from state
        const [statePda] = getStatePda();
        const stateInfo = await conn.getAccountInfo(statePda);
        if (stateInfo && stateInfo.data.length >= 8) {
          // flash_loan_callback_program is near the end; we'll just read the entire account and fetch it from the state directly
          // Use the fetchProtocolState-style offset to get it
          const cbBytes = new Uint8Array(stateInfo.data.buffer, stateInfo.data.byteOffset, stateInfo.data.length);
          let off = 8 + 32 * 4 + 1 + 8 + 8 + 1 + 8 + 8 + 6 + 8 + 16 + 8;
          off += 1;
          const hasPending = stateInfo.data[off] === 1; off += 1;
          if (hasPending) {
            off += 1 + 8 + 4;
            const vecLen = new DataView(stateInfo.data.buffer, stateInfo.data.byteOffset + (off - 4), 4).getUint32(0, true);
            off += vecLen + 3 + 32;
          }
          off += 1 + 16 + 8 + 2;
          const flcbBytes = new Uint8Array(stateInfo.data.buffer, stateInfo.data.byteOffset + off, 32);
          const flcbPk = new PublicKey(flcbBytes);
          setApprovedCbProgram(flcbPk.equals(PublicKey.default) ? "Not approved" : flcbPk.toBase58());
          if (flcbPk.equals(PublicKey.default)) {
            setCbProgram(""); 
          } else {
            setCbProgram(flcbPk.toBase58());
          }
        }
      } catch {}
    })();
  }, [provider]);

  const handleFlashLoan = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const p = parseFloat(amt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid flash loan amount.");
      const raw = new BN(Math.floor(p * LAMPORTS_PER_SOL));
      const cbPk = new PublicKey(cbProgram);
      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const borrowerAta = getAssociatedTokenAddressSync(WSOL_MINT, pk);
      const tx = await program.methods.flashLoan(raw, cbPk).accounts({
        borrower: pk, borrowerTokenAccount: borrowerAta,
        pool: poolPda, poolTokenA, poolTokenB,
        state: sp, tokenProgram: TOKEN_PROGRAM_ID,
        clock: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
      }).rpc();
      setS("confirmed"); setOk(`Flash loan executed! TX: ${tx.slice(0, 12)}...`); setAmt("");
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amt, cbProgram]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">Pool Information</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Constant-product AMM (x·y=k) between SOL and USDC. <span className="cursor-help underline decoration-dotted" title="Fees are set by the admin at pool creation. Flash loan fee is hardcoded in the contract at 30 bps.">Fees set by admin ⓘ</span>
        </p>
      </div>
      <div className="grid grid-cols-1 xs:grid-cols-2 gap-3 sm:gap-4">
        <SC label="Swap Fee" value={poolFee ?? "..."} />
        <SC label="Flash Loan Fee" value={poolFlashFee ?? "..."} />
        <SC label="SOL Liquidity" value={poolSolBal ?? "..."} />
        <SC label="USDC Liquidity" value={poolUsdcBal ?? "..."} />
        <SC label="LP Token Mint" value={poolLpMintAddr ?? "..."} />
        <SC label="Token A (SOL)" value={WSOL_MINT.toBase58().slice(0,10)+"..."} />
        <SC label="Token B (USDC)" value={USDC_MINT.toBase58().slice(0,10)+"..."} />
      </div>

      {/* Advanced: Flash Loan (hidden by default) */}
      <div className="pt-2 border-t border-sky-500/10">
        <button onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-sky-400 transition-colors">
          <span>{showAdvanced ? "▼" : "▶"}</span>
          <span>Advanced: Flash Loan (for developers)</span>
        </button>
      </div>
      {showAdvanced && (
        <div className="glass rounded-xl p-4 border-purple-500/10 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <h4 className="text-sm font-semibold text-purple-300">Flash Loan</h4>
          </div>
          <p className="text-xs text-slate-500">
            Borrow assets instantly. Must be repaid within the same transaction by a callback program. 
            {approvedCbProgram && approvedCbProgram !== "Not approved" ? (
              <span className="text-emerald-400 block mt-1">✓ Approved callback: <span className="font-mono">{approvedCbProgram.slice(0, 12)}...</span></span>
            ) : (
              <span className="text-amber-400 block mt-1">⚠ No approved callback program. Admins must approve one via governance.</span>
            )}
          </p>
          <InpTxt label="Callback Program ID (auto-filled if approved)" val={cbProgram} set={setCbProgram} ph="Enter program public key" />
          <Inp label="Amount (SOL)" val={amt} set={setAmt} ph="0.0" />
          <ABtn label="Execute Flash Loan" onClick={handleFlashLoan} status={s} disabled={!amt || !cbProgram} />
          <Err message={err} /><Ok message={ok} />
        </div>
      )}
    </div>
  );
}
function SC({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-xl p-3 sm:p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-xs sm:text-sm text-slate-300 font-mono mt-1 break-all">{value}</p>
    </div>
  );
}

function KV({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="glass rounded-lg p-2 sm:p-3">
      <p className="text-[10px] sm:text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-xs sm:text-sm font-mono mt-0.5 break-all ${accent ?? "text-slate-300"}`}>{value}</p>
    </div>
  );
}

/* ─── LIQUIDITY ──────────────────────────────────────── */
function LiquidityPanel({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amtA, setAmtA] = useState(""); const [amtB, setAmtB] = useState("");
  const [minLp, setMinLp] = useState("");
  const [lpAmt, setLpAmt] = useState("");
  const [minA, setMinA] = useState(""); const [minB, setMinB] = useState("");
  const [s, setS] = useState<TxStatus>("idle");
  const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  // User's LP position
  const [userLpBal, setUserLpBal] = useState<string | null>(null);
  const [userLpShare, setUserLpShare] = useState<string | null>(null);
  // User's staking positions
  const [userStakedSol, setUserStakedSol] = useState<string | null>(null);
  const [userStakedUsdc, setUserStakedUsdc] = useState<string | null>(null);
  const [userPendingRewardsSol, setUserPendingRewardsSol] = useState<string | null>(null);
  const [userPendingRewardsUsdc, setUserPendingRewardsUsdc] = useState<string | null>(null);

  // Refresh interval for real-time updates
  const [portfolioKey, setPortfolioKey] = useState(0);

  // Read all user positions (staking + LP)
  useEffect(() => {
    if (!provider || !pk) return;
    (async () => {
      const conn = provider.connection;
      // LP position
      try {
        const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
        const [lpMint] = getPoolLpMintPda(poolPda);
        const userLpAta = getAssociatedTokenAddressSync(lpMint, pk);
        const lpInfo = await conn.getAccountInfo(userLpAta);
        if (lpInfo && lpInfo.data.length >= 72) {
          const bal = new DataView(lpInfo.data.buffer, lpInfo.data.byteOffset + 64, 8).getBigUint64(0, true);
          setUserLpBal((Number(bal) / 1e9).toFixed(6));
          const mintInfo = await conn.getAccountInfo(lpMint);
          if (mintInfo && mintInfo.data.length >= 44) {
            const supply = new DataView(mintInfo.data.buffer, mintInfo.data.byteOffset + 36, 8).getBigUint64(0, true);
            if (supply > BigInt(0)) {
              const share = Number(bal) / Number(supply) * 100;
              setUserLpShare(share < 0.01 ? "<0.01" : share.toFixed(2));
            } else { setUserLpShare("0"); }
          }
        } else { setUserLpBal("0"); setUserLpShare("0"); }
      } catch { setUserLpBal(null); setUserLpShare(null); }

      // SOL stake
      try {
        const [solStakePda] = getUserStakePda(pk, 0);
        const solInfo = await conn.getAccountInfo(solStakePda);
        if (solInfo && solInfo.data.length >= 8 + 72) {
          const dv = new DataView(solInfo.data.buffer, solInfo.data.byteOffset + 8, solInfo.data.length - 8);
          // offset: user(32) + staked_amount(8) + reward_per_token_paid(16) + pending_rewards(8) + token_type(1)
          const stakeAmt = dv.getBigUint64(32, true);
          const pendRew = dv.getBigUint64(56, true);
          setUserStakedSol((Number(stakeAmt) / 1e9).toFixed(4));
          setUserPendingRewardsSol((Number(pendRew) / 1e9).toFixed(6));
        } else { setUserStakedSol("0"); setUserPendingRewardsSol("0"); }
      } catch { setUserStakedSol(null); setUserPendingRewardsSol(null); }

      // USDC stake
      try {
        const [usdcStakePda] = getUserStakePda(pk, 1);
        const usdcInfo = await conn.getAccountInfo(usdcStakePda);
        if (usdcInfo && usdcInfo.data.length >= 8 + 72) {
          const dv = new DataView(usdcInfo.data.buffer, usdcInfo.data.byteOffset + 8, usdcInfo.data.length - 8);
          const stakeAmt = dv.getBigUint64(32, true);
          const pendRew = dv.getBigUint64(56, true);
          setUserStakedUsdc((Number(stakeAmt) / 1e6).toFixed(2));
          setUserPendingRewardsUsdc((Number(pendRew) / 1e9).toFixed(6));
        } else { setUserStakedUsdc("0"); setUserPendingRewardsUsdc("0"); }
      } catch { setUserStakedUsdc(null); setUserPendingRewardsUsdc(null); }
    })();
  }, [provider, pk, portfolioKey]);

  const handleAdd = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const a = parseFloat(amtA); const b = parseFloat(amtB); const m = parseFloat(minLp);
      if (isNaN(a) || a <= 0) throw new Error("Enter valid Amount A (SOL).");
      if (isNaN(b) || b <= 0) throw new Error("Enter valid Amount B (USDC).");
      if (isNaN(m) || m < 0) throw new Error("Enter valid minimum LP amount.");
      const rawA = new BN(Math.floor(a * LAMPORTS_PER_SOL));
      const rawB = new BN(Math.floor(b * 1_000_000)); // USDC 6 decimals
      const rawMin = new BN(Math.floor(m * LAMPORTS_PER_SOL));
      const conn = provider.connection;

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const userAtaA = getAssociatedTokenAddressSync(WSOL_MINT, pk);
      const userAtaB = getAssociatedTokenAddressSync(USDC_MINT, pk);
      const userLpAta = getAssociatedTokenAddressSync(lpMint, pk);

      // Ensure WSOL ATA exists and wrap SOL if needed
      const ataAInfo = await conn.getAccountInfo(userAtaA);
      if (!ataAInfo) {
        const { blockhash: bh } = await conn.getLatestBlockhash();
        const ix = createAssociatedTokenAccountInstruction(pk, userAtaA, pk, WSOL_MINT);
        const ctrx = new Transaction().add(ix); ctrx.feePayer = pk; ctrx.recentBlockhash = bh;
        await provider.sendAndConfirm(ctrx, []);
      }
      const postAta = await conn.getAccountInfo(userAtaA);
      const wsolBal = postAta && postAta.data.length >= 72
        ? new DataView(postAta.data.buffer, postAta.data.byteOffset + 64, 8).getBigUint64(0, true)
        : BigInt(0);
      if (wsolBal < BigInt(Math.floor(a * LAMPORTS_PER_SOL))) {
        const wrapNeeded = BigInt(Math.floor(a * LAMPORTS_PER_SOL)) - wsolBal;
        const { blockhash: bh2 } = await conn.getLatestBlockhash();
        const wrapTx = new Transaction()
          .add(SystemProgram.transfer({ fromPubkey: pk, toPubkey: userAtaA, lamports: Number(wrapNeeded) }))
          .add(createSyncNativeInstruction(userAtaA));
        wrapTx.feePayer = pk; wrapTx.recentBlockhash = bh2;
        await provider.sendAndConfirm(wrapTx, []);
      }

      // Ensure USDC ATA exists
      const ataBInfo = await conn.getAccountInfo(userAtaB);
      if (!ataBInfo) {
        const { blockhash: bh3 } = await conn.getLatestBlockhash();
        const ix = createAssociatedTokenAccountInstruction(pk, userAtaB, pk, USDC_MINT);
        const ctrx = new Transaction().add(ix); ctrx.feePayer = pk; ctrx.recentBlockhash = bh3;
        await provider.sendAndConfirm(ctrx, []);
      }

      // Ensure LP token ATA exists (the program mints LP tokens here)
      const lpAtaInfo = await conn.getAccountInfo(userLpAta);
      if (!lpAtaInfo) {
        const { blockhash: bh4 } = await conn.getLatestBlockhash();
        const ix = createAssociatedTokenAccountInstruction(pk, userLpAta, pk, lpMint);
        const ctrx = new Transaction().add(ix); ctrx.feePayer = pk; ctrx.recentBlockhash = bh4;
        await provider.sendAndConfirm(ctrx, []);
      }

      const tx = await program.methods.addLiquidity(rawA, rawB, rawMin).accounts({
        user: pk, userTokenA: userAtaA, userTokenB: userAtaB,
        userLpTokenAccount: userLpAta,
        pool: poolPda, poolTokenA, poolTokenB, lpTokenMint: lpMint,
        state: sp, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      }).rpc();
      setS("confirmed"); setOk(`Liquidity added! TX: ${tx.slice(0, 12)}...`);
      setAmtA(""); setAmtB(""); setMinLp("");
      setPortfolioKey(k => k + 1); // refresh portfolio
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, amtA, amtB, minLp]);

  const handleRemove = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setErr(""); setOk(""); setS("sending");
    try {
      const lp = parseFloat(lpAmt); const ma = parseFloat(minA); const mb = parseFloat(minB);
      if (isNaN(lp) || lp <= 0) throw new Error("Enter valid LP amount.");
      if (isNaN(ma) || ma < 0) throw new Error("Enter valid min Token A.");
      if (isNaN(mb) || mb < 0) throw new Error("Enter valid min Token B.");
      const rawLp = new BN(Math.floor(lp * LAMPORTS_PER_SOL));
      const rawMA = new BN(Math.floor(ma * LAMPORTS_PER_SOL));
      const rawMB = new BN(Math.floor(mb * 1_000_000));

      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
      const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
      const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const userAtaA = getAssociatedTokenAddressSync(WSOL_MINT, pk);
      const userAtaB = getAssociatedTokenAddressSync(USDC_MINT, pk);
      const userLpAta = getAssociatedTokenAddressSync(lpMint, pk);

      const tx = await program.methods.removeLiquidity(rawLp, rawMA, rawMB).accounts({
        user: pk, userTokenA: userAtaA, userTokenB: userAtaB,
        userLpTokenAccount: userLpAta,
        pool: poolPda, poolTokenA, poolTokenB, lpTokenMint: lpMint,
        state: sp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setS("confirmed"); setOk(`Liquidity removed! TX: ${tx.slice(0, 12)}...`);
      setLpAmt(""); setMinA(""); setMinB("");
      setPortfolioKey(k => k + 1); // refresh portfolio
    } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
  }, [program, provider, pk, lpAmt, minA, minB]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-sky-300">Liquidity Management</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Add SOL+USDC to earn swap fees, or remove LP tokens.</p>
      </div>

      {/* ─── MY PORTFOLIO ─── */}
      <div className="rounded-xl border border-emerald-500/10 overflow-hidden">
        <div className="p-2 sm:p-3 bg-emerald-500/5 border-b border-emerald-500/10">
          <h4 className="text-xs font-semibold text-emerald-400 flex items-center gap-2">
            <span>📊</span> My Portfolio
          </h4>
        </div>
        <div className="p-2 sm:p-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <KV label="Staked SOL" value={userStakedSol !== null ? `${userStakedSol} SOL` : "—"} />
          <KV label="SOL Rewards" value={userPendingRewardsSol !== null ? `${userPendingRewardsSol} SOL` : "—"} accent={userPendingRewardsSol && parseFloat(userPendingRewardsSol) > 0 ? "text-amber-300" : undefined} />
          <KV label="Staked USDC" value={userStakedUsdc !== null ? `${userStakedUsdc} USDC` : "—"} />
          <KV label="USDC Rewards" value={userPendingRewardsUsdc !== null ? `${userPendingRewardsUsdc} SOL` : "—"} accent={userPendingRewardsUsdc && parseFloat(userPendingRewardsUsdc) > 0 ? "text-amber-300" : undefined} />
          <KV label="LP Tokens" value={userLpBal !== null ? `${userLpBal} LP` : "—"} />
          <KV label="Pool Share" value={userLpShare !== null ? `${userLpShare}%` : "—"} />
        </div>
      </div>

      <div className="flex gap-2">
        {(["add", "remove"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
              mode === m ? "bg-emerald-500/20 border border-emerald-400/40 text-emerald-300" : "glass text-slate-500 hover:text-slate-300"
            }`}>{m === "add" ? "+ Add" : "− Remove"}</button>
        ))}
      </div>
      {mode === "add" ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Inp label="Amount A (SOL)" val={amtA} set={setAmtA} />
            <Inp label="Amount B (USDC)" val={amtB} set={setAmtB} />
          </div>
          <Inp label="Min LP Tokens (slippage)" val={minLp} set={setMinLp} />
          <ABtn label="Add Liquidity" onClick={handleAdd} status={s} disabled={!amtA || !amtB} />
          <Err message={err} /><Ok message={ok} />
        </>
      ) : (
        <>
          <Inp label="LP Token Amount" val={lpAmt} set={setLpAmt} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Inp label="Min Token A (SOL)" val={minA} set={setMinA} />
            <Inp label="Min Token B (USDC)" val={minB} set={setMinB} />
          </div>
          <ABtn label="Remove Liquidity" onClick={handleRemove} status={s} disabled={!lpAmt} />
          <div className="pt-2 border-t border-emerald-500/10">
            <p className="text-xs text-amber-400/80 mb-2">⚠️ Emergency: Remove all liquidity when protocol is paused.</p>
            <ABtn label="Emergency Remove" onClick={async () => {
              if (!program || !provider || !pk) return;
              setErr(""); setOk(""); setS("sending");
              try {
                const lp = parseFloat(lpAmt);
                if (isNaN(lp) || lp <= 0) throw new Error("Enter valid LP amount.");
                const rawLp = new BN(Math.floor(lp * LAMPORTS_PER_SOL));
                const [sp] = getStatePda();
                const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
                const [poolTokenA] = getPoolTokenPda(poolPda, "token_a");
                const [poolTokenB] = getPoolTokenPda(poolPda, "token_b");
                const [lpMint] = getPoolLpMintPda(poolPda);
                const userAtaA = getAssociatedTokenAddressSync(WSOL_MINT, pk);
                const userAtaB = getAssociatedTokenAddressSync(USDC_MINT, pk);
                const userLpAta = getAssociatedTokenAddressSync(lpMint, pk);
                const tx = await program.methods.emergencyRemoveLiquidity(rawLp).accounts({
                  user: pk, userTokenA: userAtaA, userTokenB: userAtaB,
                  userLpTokenAccount: userLpAta,
                  pool: poolPda, poolTokenA, poolTokenB, lpTokenMint: lpMint,
                  state: sp, tokenProgram: TOKEN_PROGRAM_ID,
                }).rpc();
                setS("confirmed"); setOk(`Emergency liquidity removed! TX: ${tx.slice(0, 12)}...`); setLpAmt("");
              } catch (e) { setS("error"); setErr(parseErrorMessage(e)); }
            }} status={s} disabled={!lpAmt} />
          </div>
          <Err message={err} /><Ok message={ok} />
        </>
      )}
    </div>
  );
}

/* ─── ADMIN ──────────────────────────────────────────── */
type SectionKey = "state" | "sol" | "fundSol" | "usdc" | "fundUsdc" | "pool" | "govPause" | "govApprove";

function AdminPanel({ program, provider }: { program: any; provider: any }) {
  const { publicKey: pk } = useWallet();

  const empty = () => ({ status: "idle" as TxStatus, err: "", ok: "", init: false });
  const [sec, setSec] = useState<Record<SectionKey, { status: TxStatus; err: string; ok: string; init: boolean }>>({
    state: empty(), sol: empty(), fundSol: empty(), usdc: empty(), fundUsdc: empty(), pool: empty(),
    govPause: empty(), govApprove: empty(),
  });

  const setSection = (k: SectionKey, v: Partial<{ status: TxStatus; err: string; ok: string; init: boolean }>) => {
    setSec((prev) => ({ ...prev, [k]: { ...prev[k], ...v } }));
  };

  // ── Multi-sig signer keys (full, fetched from on-chain) ──
  const [signerFull, setSignerFull] = useState<{s1: string; s2: string; s3: string} | null>(null);
  const [signerTrunc, setSignerTrunc] = useState<{s1: string; s2: string; s3: string} | null>(null);
  const currentSignerIndex = signerFull && pk
    ? (pk.toBase58() === signerFull.s1 ? 1 : pk.toBase58() === signerFull.s2 ? 2 : pk.toBase58() === signerFull.s3 ? 3 : 0)
    : 0;

  // ── Initialize State ──
  const [signer1, setS1] = useState("");
  const [signer2, setS2] = useState("");
  const [signer3, setS3] = useState("");
  const [timelock, setTimelock] = useState("86400");

  const handleInitState = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("state", { err: "", ok: "", status: "sending" });
    try {
      if (!signer1 || !signer2 || !signer3) throw new Error("All three signer public keys are required.");
      const s1 = new PublicKey(signer1); const s2 = new PublicKey(signer2);
      const s3 = new PublicKey(signer3); const tl = parseInt(timelock);
      if (isNaN(tl) || tl < 0) throw new Error("Timelock delay must be a positive number.");
      const [sp] = getStatePda();
      const tx = await program.methods.initializeState(s1, s2, s3, new BN(tl)).accounts({
        state: sp, authority: pk, systemProgram: SystemProgram.programId,
      }).rpc();
      setSection("state", { status: "confirmed", init: true, ok: `State initialized! TX: ${tx.slice(0, 12)}...` });
    } catch (e) { setSection("state", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk, signer1, signer2, signer3, timelock]);

  // ── Initialize SOL Accounts ──
  const handleInitSol = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("sol", { err: "", ok: "", status: "sending" });
    try {
      const [sp] = getStatePda();
      const [stakingPoolSol] = getStakingPoolPda(0);
      const [rewardVaultSol] = getRewardVaultPda(0);
      const [treasurySol] = getTreasuryPda(WSOL_MINT);
      const tx = await program.methods.initializeSolAccounts().accounts({
        state: sp, stakingPoolSol, rewardVaultSol,
        protocolTreasurySol: treasurySol, solMint: WSOL_MINT,
        authority: pk, systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      }).rpc();
      setSection("sol", { status: "confirmed", init: true, ok: `SOL accounts initialized! TX: ${tx.slice(0, 12)}...` });
    } catch (e) { setSection("sol", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk]);

  // ── Initialize USDC (creates mint + PDA accounts; idempotent — skips if already done) ──
  const handleInitUsdc = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("usdc", { err: "", ok: "", status: "sending" });
    try {
      const conn = provider.connection;
      const { createInitializeMint2Instruction, getMinimumBalanceForRentExemptMint, MINT_SIZE } = await import("@solana/spl-token");

      // Step A: Recover or create USDC mint
      const [sp] = getStatePda();
      const [stakingPoolUsdc] = getStakingPoolPda(1);

      // Check if staking pool PDA already exists (means USDC accounts were initialized before)
      const existingStakingPool = await conn.getAccountInfo(stakingPoolUsdc);
      if (existingStakingPool && USDC_MINT.equals(PublicKey.default)) {
        // Recover mint from existing staking pool's mint field (offset 0 = mint, 32 = owner, 36 = amount in TokenAccount layout)
        USDC_MINT = new PublicKey(existingStakingPool.data.slice(0, 32));
        try { localStorage.setItem(USDC_MINT_KEY, USDC_MINT.toBase58()); } catch {}
      }

      if (USDC_MINT.equals(PublicKey.default)) {
        // Need to create a new mint
        const mintKp = new Keypair();
        const rent = await getMinimumBalanceForRentExemptMint(conn);
        const createMintIx = [
          SystemProgram.createAccount({
            fromPubkey: pk, newAccountPubkey: mintKp.publicKey,
            lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(mintKp.publicKey, 6, pk, pk),
        ];
        const { blockhash } = await conn.getLatestBlockhash();
        const mintTx = new Transaction().add(...createMintIx);
        mintTx.feePayer = pk; mintTx.recentBlockhash = blockhash;
        await provider.sendAndConfirm(mintTx, [mintKp]);
        USDC_MINT = mintKp.publicKey;
        try { localStorage.setItem(USDC_MINT_KEY, USDC_MINT.toBase58()); } catch {}
      }

      // Step B: Initialize PDA accounts for USDC (skip if already done)
      let tx2 = "";
      if (!existingStakingPool) {
        const [rewardVaultUsdc] = getRewardVaultPda(1);
        const [treasuryUsdc] = getTreasuryPda(USDC_MINT);
        tx2 = await program.methods.initializeUsdcAccounts().accounts({
          state: sp, stakingPoolUsdc, rewardVaultUsdc,
          protocolTreasuryUsdc: treasuryUsdc, usdcMint: USDC_MINT,
          authority: pk, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        }).rpc();
      }

      // Step C: Create user ATA + mint tokens
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, pk);
      const ataInfo = await conn.getAccountInfo(userUsdcAta);
      if (!ataInfo) {
        const { blockhash: bh3 } = await conn.getLatestBlockhash();
        const createAtaIx = createAssociatedTokenAccountInstruction(pk, userUsdcAta, pk, USDC_MINT);
        const ataTx = new Transaction().add(createAtaIx);
        ataTx.feePayer = pk; ataTx.recentBlockhash = bh3;
        await provider.sendAndConfirm(ataTx, []);
      }
      // Mint 1,000,000 USDC tokens to the user
      const { blockhash: bh4 } = await conn.getLatestBlockhash();
      const mintTx2 = new Transaction().add(
        createMintToInstruction(USDC_MINT, userUsdcAta, pk, BigInt("1000000000000"))
      );
      mintTx2.feePayer = pk; mintTx2.recentBlockhash = bh4;
      await provider.sendAndConfirm(mintTx2, []);

      setSection("usdc", {
        status: "confirmed", init: true,
        ok: `USDC ready. 1,000,000 USDC minted to your wallet. Mint: ${USDC_MINT.toBase58().slice(0, 12)}...${tx2 ? ` PDA TX: ${tx2.slice(0, 12)}...` : " (PDA already existed)"}`
      });
      await fetchProtocolState();
    } catch (e) { setSection("usdc", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk]);

  // ── Fund SOL Reward Vault (auto-wraps SOL → WSOL) ──
  const [fundSolAmt, setFundSolAmt] = useState("");
  const handleFundSol = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("fundSol", { err: "", ok: "", status: "sending" });
    try {
      const p = parseFloat(fundSolAmt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount. Minimum: 1 SOL.");
      const lamports = Math.floor(p * LAMPORTS_PER_SOL);
      if (lamports < LAMPORTS_PER_SOL) throw new Error("Minimum funding: 1 SOL. Enter at least 1.0.");
      const raw = new BN(lamports);
      const [sp] = getStatePda();
      const [rv] = getRewardVaultPda(0);
      const conn = provider.connection;

      // Step 1: Create WSOL ATA if needed
      let ata = getAssociatedTokenAddressSync(WSOL_MINT, pk);
      const ataInfo = await conn.getAccountInfo(ata);
      if (!ataInfo) {
        const { blockhash: bh } = await conn.getLatestBlockhash();
        const ix = createAssociatedTokenAccountInstruction(pk, ata, pk, WSOL_MINT);
        const ctrx = new Transaction().add(ix); ctrx.feePayer = pk; ctrx.recentBlockhash = bh;
        await provider.sendAndConfirm(ctrx, []);
      }

      // Step 2: Wrap SOL → WSOL (transfer native SOL + syncNative)
      const { blockhash: bh2 } = await conn.getLatestBlockhash();
      const wrapTx = new Transaction()
        .add(SystemProgram.transfer({ fromPubkey: pk, toPubkey: ata, lamports }))
        .add(createSyncNativeInstruction(ata));
      wrapTx.feePayer = pk; wrapTx.recentBlockhash = bh2;
      await provider.sendAndConfirm(wrapTx, []);

      // Step 3: Fund the reward vault
      const tx = await program.methods.fundRewardVault(raw, 0).accounts({
        authority: pk, authorityTokenAccount: ata,
        rewardVault: rv, stakeMint: WSOL_MINT,
        state: sp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setSection("fundSol", { status: "confirmed", ok: `SOL vault funded! TX: ${tx.slice(0, 12)}...` });
      setFundSolAmt("");
      // Refresh protocol state after funding
      await fetchProtocolState();
    } catch (e) { setSection("fundSol", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk, fundSolAmt]);

  // ── Fund USDC Reward Vault (self-contained: recovers mint, creates ATA, mints tokens) ──
  const [fundUsdcAmt, setFundUsdcAmt] = useState("");
  const handleFundUsdc = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("fundUsdc", { err: "", ok: "", status: "sending" });
    try {
      const p = parseFloat(fundUsdcAmt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount. Minimum: 0.01 USDC.");
      const rawAmount = new BN(Math.floor(p * 1_000_000));
      if (rawAmount.isZero()) throw new Error("Minimum 0.01 USDC required.");
      const conn = provider.connection;

      // Step 1: Recover USDC_MINT if missing (from localStorage or on-chain staking pool)
      if (USDC_MINT.equals(PublicKey.default)) {
        const saved = typeof localStorage !== "undefined" ? localStorage.getItem(USDC_MINT_KEY) : null;
        if (saved) {
          USDC_MINT = new PublicKey(saved);
        } else {
          // Try to recover from the on-chain staking pool PDA
          const [stakingPoolUsdc] = getStakingPoolPda(1);
          const spInfo = await conn.getAccountInfo(stakingPoolUsdc);
          if (spInfo) {
            USDC_MINT = new PublicKey(spInfo.data.slice(0, 32));
            try { localStorage.setItem(USDC_MINT_KEY, USDC_MINT.toBase58()); } catch {}
          } else {
            throw new Error("USDC not initialized. Run 'Initialize USDC Accounts' (Section 3) first.");
          }
        }
      }

      // Step 2: Ensure user has a USDC ATA
      const ata = getAssociatedTokenAddressSync(USDC_MINT, pk);
      const ataInfo = await conn.getAccountInfo(ata);
      if (!ataInfo) {
        const { blockhash: bh } = await conn.getLatestBlockhash();
        const createAtaIx = createAssociatedTokenAccountInstruction(pk, ata, pk, USDC_MINT);
        const ataTx = new Transaction().add(createAtaIx);
        ataTx.feePayer = pk; ataTx.recentBlockhash = bh;
        await provider.sendAndConfirm(ataTx, []);
      }

      // Step 3: Mint some USDC if balance is insufficient
      const postAtaInfo = await conn.getAccountInfo(ata);
      const currentBalance = postAtaInfo && postAtaInfo.data.length >= 72
        ? new DataView(postAtaInfo.data.buffer, postAtaInfo.data.byteOffset + 64, 8).getBigUint64(0, true)
        : BigInt(0);
      if (currentBalance < BigInt(rawAmount.toString())) {
        const mintTarget = BigInt(rawAmount.toString()) + (currentBalance > BigInt(10000) ? BigInt(0) : BigInt("1000000000000")); // also top up to 1M USDC if low
        const { blockhash: bhMint } = await conn.getLatestBlockhash();
        const mintTx = new Transaction().add(
          createMintToInstruction(USDC_MINT, ata, pk, mintTarget)
        );
        mintTx.feePayer = pk; mintTx.recentBlockhash = bhMint;
        await provider.sendAndConfirm(mintTx, []);
      }

      // Step 4: Fund the USDC reward vault
      const [sp] = getStatePda();
      const [rv] = getRewardVaultPda(1);
      const rvInfo = await conn.getAccountInfo(rv);
      if (!rvInfo) throw new Error("USDC reward vault PDA not found. Run 'Initialize USDC Accounts' (Section 3) first.");

      const tx = await program.methods.fundRewardVault(rawAmount, 1).accounts({
        authority: pk, authorityTokenAccount: ata,
        rewardVault: rv, stakeMint: USDC_MINT,
        state: sp, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      setSection("fundUsdc", { status: "confirmed", ok: `USDC vault funded! TX: ${tx.slice(0, 12)}...` });
      setFundUsdcAmt("");
      await fetchProtocolState();
    } catch (e) { setSection("fundUsdc", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk, fundUsdcAmt]);

  // ── Create Pool ──
  const [feeBps, setFeeBps] = useState("30");
  const handleCreatePool = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("pool", { err: "", ok: "", status: "sending" });
    try {
      const fee = parseInt(feeBps);
      if (isNaN(fee) || fee < 0 || fee > 10000) throw new Error("Fee must be 0-10000 basis points.");
      const [sp] = getStatePda();
      const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
      const [tokenAAccount] = getPoolTokenPda(poolPda, "token_a");
      const [tokenBAccount] = getPoolTokenPda(poolPda, "token_b");
      const [lpMint] = getPoolLpMintPda(poolPda);
      const tx = await program.methods.createPool(fee).accounts({
        pool: poolPda, tokenAMint: WSOL_MINT, tokenBMint: USDC_MINT,
        tokenAAccount, tokenBAccount, lpTokenMint: lpMint,
        state: sp, authority: pk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      }).rpc();
      setSection("pool", { status: "confirmed", init: true, ok: `Pool created! TX: ${tx.slice(0, 12)}...` });
    } catch (e) { setSection("pool", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk, feeBps]);

  // ── Protocol state fields (read live from on-chain) ──
  const [balSol, setBalSol] = useState<string | null>(null);
  const [balUsdc, setBalUsdc] = useState<string | null>(null);
  const [protocolPaused, setProtocolPaused] = useState<boolean | null>(null);
  const [totalStakedSol, setTotalStakedSol] = useState<string | null>(null);
  const [totalStakedUsdc, setTotalStakedUsdc] = useState<string | null>(null);
  const [rewardRate, setRewardRate] = useState<string | null>(null);
  const [totalRewardsDistributed, setTotalRewardsDistributed] = useState<string | null>(null);
  const [timelockDelay, setTimelockDelay] = useState<string | null>(null);
  const [requiredSignatures, setRequiredSignatures] = useState<string | null>(null);
  const [minStakeAmt, setMinStakeAmt] = useState<string | null>(null);
  const [protocolFeeBps, setProtocolFeeBps] = useState<string | null>(null);
  const [flashLoanCbProgram, setFlashLoanCbProgram] = useState<string | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<string | null>(null);
  const [pendingActionInfo, setPendingActionInfo] = useState<string | null>(null);
  const [rewardPerTokenStored, setRewardPerTokenStored] = useState<string | null>(null);
  const [upgradeVersion, setUpgradeVersion] = useState<string | null>(null);

  /** Read all on-chain state fields from the ProgramState PDA */
  const fetchProtocolState = useCallback(async () => {
    if (!provider) return;
    const conn = provider.connection;
    try {
      const [statePda] = getStatePda();
      const info = await conn.getAccountInfo(statePda);
      if (info && info.data.length >= 8) {
        const data = info.data;
        const dv = new DataView(data.buffer, data.byteOffset, data.length);
        let offset = 8; // skip 8-byte anchor discriminator

        // Skip authority (32) + signer1 (32) + signer2 (32) + signer3 (32) = 128 bytes
        offset += 32 + 32 + 32 + 32; // 136

        const reqSigs = dv.getUint8(offset); offset += 1;
        setRequiredSignatures(String(reqSigs));

        const tss = dv.getBigUint64(offset, true); offset += 8;
        setTotalStakedSol((Number(tss) / 1e9).toFixed(4));

        const tsu = dv.getBigUint64(offset, true); offset += 8;
        setTotalStakedUsdc((Number(tsu) / 1e6).toFixed(2));

        const paused = dv.getUint8(offset) === 1; offset += 1;
        setProtocolPaused(paused);

        const rr = dv.getBigUint64(offset, true); offset += 8;
        setRewardRate(String(rr));

        const trd = dv.getBigUint64(offset, true); offset += 8;
        setTotalRewardsDistributed((Number(trd) / 1e9).toFixed(4));

        // Skip 6 bump fields (6 bytes)
        offset += 6;

        const ltu = dv.getBigInt64(offset, true); offset += 8;
        setLastUpdateTime(ltu ? new Date(Number(ltu) * 1000).toLocaleString() : "N/A");

        // reward_per_token_stored (u128 = 16 bytes)
        const rptsHi = dv.getBigUint64(offset, true); offset += 8;
        const rptsLo = dv.getBigUint64(offset, true); offset += 8;
        setRewardPerTokenStored(rptsHi > BigInt(0) ? `${rptsHi}.${rptsLo}` : String(rptsLo));

        const tld = dv.getBigInt64(offset, true); offset += 8;
        setTimelockDelay(tld ? `${Number(tld) / 3600}h` : "0h");

        // pending_action: 1 byte option prefix
        const hasPending = dv.getUint8(offset) === 1; offset += 1;
        if (hasPending) {
          // ActionType variant byte + proposed_at (i64 8) + data vec length (4+len) + approvals [bool;3] (3) + created_by (32)
          const actionType = dv.getUint8(offset); offset += 1;
          const actionNames = ["Pause", "Unpause", "UpdateRewardRate", "UpdateFlashLoanCallbackProgram"];
          const actionName = actionNames[actionType] || `Unknown(${actionType})`;
          const proposedAt = dv.getBigInt64(offset, true); offset += 8;
          const vecLen = dv.getUint32(offset, true); offset += 4;
          offset += vecLen; // skip data bytes
          const approvals = [dv.getUint8(offset) === 1, dv.getUint8(offset + 1) === 1, dv.getUint8(offset + 2) === 1];
          offset += 3;
          offset += 32; // skip created_by
          const approvalCount = approvals.filter(Boolean).length;
          setPendingActionInfo(`${actionName} — ${approvalCount}/3 approved (proposed ${new Date(Number(proposedAt) * 1000).toLocaleString()})`);
          // Also update governance state
          setHasActiveProposal(true);
          setProposalActionType(actionName);
          setApprovedBy(approvals);
          setApprovalCount(approvalCount);
          setProposedAt(Number(proposedAt));
        } else {
          setPendingActionInfo("None");
        }

        const uv = dv.getUint8(offset); offset += 1;
        setUpgradeVersion(String(uv));

        // precision (u128 = 16 bytes) — skip
        offset += 16;

        const msa = dv.getBigUint64(offset, true); offset += 8;
        setMinStakeAmt((Number(msa) / 1e9).toFixed(4));

        const pfb = dv.getUint16(offset, true); offset += 2;
        setProtocolFeeBps(String(pfb));

        // flash_loan_callback_program (32 bytes)
        const flcbBytes = new Uint8Array(data.buffer, data.byteOffset + offset, 32);
        const flcbPk = new PublicKey(flcbBytes);
        setFlashLoanCbProgram(flcbPk.equals(PublicKey.default) ? "Not set" : `${flcbPk.toBase58().slice(0, 8)}...`);
        offset += 32;

      } else {
        setProtocolPaused(null);
        setPendingActionInfo(null);
      }
    } catch {
      setProtocolPaused(null);
    }

    // Also fetch reward vault balances
    try {
      const [rvSol] = getRewardVaultPda(0);
      const info = await conn.getAccountInfo(rvSol);
      if (info && info.data.length >= 72) {
        const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
        setBalSol((Number(raw) / 1e9).toFixed(4));
      } else { setBalSol(null); }
    } catch { setBalSol(null); }
    try {
      const [rvUsdc] = getRewardVaultPda(1);
      const info = await conn.getAccountInfo(rvUsdc);
      if (info && info.data.length >= 72) {
        const raw = new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true);
        setBalUsdc((Number(raw) / 1e6).toFixed(2));
      } else { setBalUsdc(null); }
    } catch { setBalUsdc(null); }
  }, [provider]);

  // ── Auto-detect initialized accounts on mount ──
  useEffect(() => {
    if (!provider) return;
    const conn = provider.connection;
    (async () => {
      try {
        const [statePda] = getStatePda();
        const stateInfo = await conn.getAccountInfo(statePda);
        if (stateInfo) {
          setSection("state", { init: true, ok: "✓ Detected on-chain" });
          // Extract signer keys from state (offset 8+32=40, 72, 104)
          if (stateInfo.data.length >= 136) {
            const s1 = new PublicKey(stateInfo.data.slice(40, 72));
            const s2 = new PublicKey(stateInfo.data.slice(72, 104));
            const s3 = new PublicKey(stateInfo.data.slice(104, 136));
            setSignerFull({ s1: s1.toBase58(), s2: s2.toBase58(), s3: s3.toBase58() });
            setSignerTrunc({
              s1: `${s1.toBase58().slice(0,6)}...${s1.toBase58().slice(-4)}`,
              s2: `${s2.toBase58().slice(0,6)}...${s2.toBase58().slice(-4)}`,
              s3: `${s3.toBase58().slice(0,6)}...${s3.toBase58().slice(-4)}`,
            });
          }
        }
      } catch {}

      try {
        const [solSp] = getStakingPoolPda(0);
        const info = await conn.getAccountInfo(solSp);
        if (info) setSection("sol", { init: true, ok: "✓ Detected on-chain" });
      } catch {}

      try {
        const [usdcSp] = getStakingPoolPda(1);
        const info = await conn.getAccountInfo(usdcSp);
        if (info) setSection("usdc", { init: true, ok: "✓ Detected on-chain" });
      } catch {}

      try {
        const [poolPda] = getPoolPda(WSOL_MINT, USDC_MINT);
        const info = await conn.getAccountInfo(poolPda);
        if (info) setSection("pool", { init: true, ok: "✓ Detected on-chain" });
      } catch {}

      await fetchProtocolState();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, fetchProtocolState]);

  // ── Governance: approval tracking ──
  const [approvalCount, setApprovalCount] = useState(0);
  const [approvedBy, setApprovedBy] = useState<boolean[]>([false, false, false]);
  const [hasActiveProposal, setHasActiveProposal] = useState(false);
  const [proposedAt, setProposedAt] = useState<number>(0);
  const [proposalActionType, setProposalActionType] = useState<string>("");
  // ── Governance proposal input values ──
  const [govRewardRate, setGovRewardRate] = useState("50");
  const [govFlCbAddr, setGovFlCbAddr] = useState("");

  const handleProposePause = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("govPause", { err: "", ok: "", status: "sending" });
    try {
      const [sp] = getStatePda();
      const tx = await program.methods.proposeAction({ pause: {} }, Buffer.from([])).accounts({
        state: sp, admin: pk,
      }).rpc();
      const myIdx = currentSignerIndex - 1; // 0-based
      const newApproved = [false, false, false];
      if (myIdx >= 0) newApproved[myIdx] = true;
      setApprovedBy(newApproved);
      setApprovalCount(1);
      setHasActiveProposal(true);
      setProposalActionType("Pause");
      setSection("govPause", { status: "confirmed", ok: `Pause proposed! 1/3 approved.` });
    } catch (e) { setSection("govPause", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk, currentSignerIndex]);

  const handleApprove = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("govApprove", { err: "", ok: "", status: "sending" });
    try {
      const [sp] = getStatePda();
      const tx = await program.methods.approveAction().accounts({
        state: sp, admin: pk,
      }).rpc();
      const myIdx = currentSignerIndex - 1;
      const newApproved = [...approvedBy];
      if (myIdx >= 0 && !newApproved[myIdx]) {
        newApproved[myIdx] = true;
        setApprovedBy(newApproved);
        const count = newApproved.filter(Boolean).length;
        setApprovalCount(count);
      }
      setSection("govApprove", { status: "confirmed", ok: `Approved! ${approvalCount + (myIdx >= 0 && !approvedBy[myIdx] ? 1 : 0)}/3` });
    } catch (e) { setSection("govApprove", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk, currentSignerIndex, approvedBy, approvalCount]);

  const handleExecutePause = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("govApprove", { err: "", ok: "", status: "sending" });
    try {
      const [sp] = getStatePda();
      const tx = await (program as any).methods.pause().accounts({
        state: sp, admin: pk,
      }).rpc();
      setSection("govApprove", { status: "confirmed", ok: `Protocol paused! TX: ${tx.slice(0, 12)}...` });
      setApprovalCount(0); setApprovedBy([false, false, false]); setHasActiveProposal(false);
    } catch (e) { setSection("govApprove", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk]);

  const handleExecuteUnpause = useCallback(async () => {
    if (!program || !provider || !pk) return;
    setSection("govApprove", { err: "", ok: "", status: "sending" });
    try {
      const [sp] = getStatePda();
      const tx = await (program as any).methods.unpause().accounts({
        state: sp, admin: pk,
      }).rpc();
      setSection("govApprove", { status: "confirmed", ok: `Protocol unpaused! TX: ${tx.slice(0, 12)}...` });
      setApprovalCount(0); setApprovedBy([false, false, false]); setHasActiveProposal(false);
    } catch (e) { setSection("govApprove", { status: "error", err: parseErrorMessage(e) }); }
  }, [program, provider, pk]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-amber-400">Admin Controls</h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Protocol initialization and multi-sig governance. Run these in order: <strong>Initialize State → Initialize SOL → Initialize USDC → Fund Rewards → Create Pool</strong>.
        </p>
      </div>

      {/* ─── SECTION: Initialize State ─── */}
      <div className="glass rounded-xl p-4 border-amber-500/10">
        <h4 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
          1. Initialize Program State
          {sec.state.init && <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-normal">✓ Initialized</span>}
          {!sec.state.init && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-normal">Pending</span>}
        </h4>
        <p className="text-xs text-slate-500 mb-3">One-time setup. Sets the authority, 3 multi-sig signers, and timelock delay.</p>
        {signerTrunc && currentSignerIndex > 0 && (
          <div className="mb-3 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            ✓ You are <strong>Signer {currentSignerIndex}</strong> — authorized for governance actions
          </div>
        )}
        {signerTrunc && (
          <div className="mb-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10 text-amber-300/90 text-xs font-mono grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div><span className="text-slate-500">Signer 1: </span>{signerTrunc.s1}{currentSignerIndex === 1 ? " (you)" : ""}{approvedBy[0] ? " ✓" : ""}</div>
            <div><span className="text-slate-500">Signer 2: </span>{signerTrunc.s2}{currentSignerIndex === 2 ? " (you)" : ""}{approvedBy[1] ? " ✓" : ""}</div>
            <div><span className="text-slate-500">Signer 3: </span>{signerTrunc.s3}{currentSignerIndex === 3 ? " (you)" : ""}{approvedBy[2] ? " ✓" : ""}</div>
          </div>
        )}
        {!sec.state.init && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <InpTxt label="Signer 1 (Pubkey)" val={signer1} set={setS1} ph="Enter base58 public key" />
              <InpTxt label="Signer 2 (Pubkey)" val={signer2} set={setS2} ph="Enter base58 public key" />
              <InpTxt label="Signer 3 (Pubkey)" val={signer3} set={setS3} ph="Enter base58 public key" />
              <Inp label="Timelock Delay (seconds)" val={timelock} set={setTimelock} ph="86400" />
            </div>
            <ABtn label="Initialize State" onClick={handleInitState} status={sec.state.status} disabled={!signer1 || !signer2 || !signer3} />
          </>
        )}
        <Err message={sec.state.err} /><Ok message={sec.state.ok} />
      </div>

      {/* ─── SECTION: Initialize SOL Accounts ─── */}
      <div className="glass rounded-xl p-4 border-amber-500/10">
        <h4 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
          2. Initialize SOL Accounts
          {sec.sol.init && <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-normal">✓ Initialized</span>}
          {!sec.sol.init && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-normal">Pending</span>}
        </h4>
        <p className="text-xs text-slate-500 mb-3">Creates staking pool, reward vault, and treasury for SOL.</p>
        <ABtn label="Initialize SOL Accounts" onClick={handleInitSol} status={sec.sol.status} />
        <Err message={sec.sol.err} /><Ok message={sec.sol.ok} />
      </div>

      {/* ─── SECTION: Fund SOL Reward Vault ─── */}
      <div className="glass rounded-xl p-4 border-emerald-500/10 border-l-2 border-l-emerald-500/30">
        <h4 className="text-sm font-semibold text-emerald-400 mb-3">SOL Reward Vault</h4>
        <p className="text-xs text-slate-500 mb-2">Deposit SOL to reward SOL stakers.</p>
        <div className="mb-3 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono">
          Balance: {balSol ?? "..."} SOL
        </div>
        <div className="mb-3">
          <Inp label="Amount (SOL)" val={fundSolAmt} set={setFundSolAmt} ph="0.0" />
        </div>
        <ABtn label="Fund SOL Vault" onClick={handleFundSol} status={sec.fundSol.status} disabled={!fundSolAmt} />
        <Err message={sec.fundSol.err} /><Ok message={sec.fundSol.ok} />
      </div>

      {/* ─── SECTION: Initialize USDC Accounts ─── */}
      <div className="glass rounded-xl p-4 border-amber-500/10">
        <h4 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
          3. Initialize USDC Accounts
          {sec.usdc.init && <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-normal">✓ Initialized</span>}
          {!sec.usdc.init && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-normal">Pending</span>}
        </h4>
        <p className="text-xs text-slate-500 mb-3">Creates staking pool, reward vault, and treasury for USDC.</p>
        <ABtn label="Initialize USDC Accounts" onClick={handleInitUsdc} status={sec.usdc.status} />
        <Err message={sec.usdc.err} /><Ok message={sec.usdc.ok} />
      </div>

      {/* ─── SECTION: Fund USDC Reward Vault ─── */}
      <div className="glass rounded-xl p-4 border-emerald-500/10 border-l-2 border-l-emerald-500/30">
        <h4 className="text-sm font-semibold text-emerald-400 mb-3">USDC Reward Vault</h4>
        <p className="text-xs text-slate-500 mb-2">Deposit USDC to reward USDC stakers.</p>
        <div className="mb-3 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono">
          Balance: {balUsdc ?? "..."} USDC
        </div>
        <div className="mb-3">
          <Inp label="Amount (USDC)" val={fundUsdcAmt} set={setFundUsdcAmt} ph="0.0" />
        </div>
        <ABtn label="Fund USDC Vault" onClick={handleFundUsdc} status={sec.fundUsdc.status} disabled={!fundUsdcAmt} />
        <Err message={sec.fundUsdc.err} /><Ok message={sec.fundUsdc.ok} />
      </div>

      {/* ─── SECTION: Create Pool ─── */}
      <div className="glass rounded-xl p-4 border-amber-500/10">
        <h4 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
          5. Create Liquidity Pool
          {sec.pool.init && <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-normal">✓ Initialized</span>}
          {!sec.pool.init && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-normal">Pending</span>}
        </h4>
        <p className="text-xs text-slate-500 mb-3">Creates the SOL/USDC AMM pool. The fee is in basis points (30 = 0.3%).</p>
        <div className="mb-3">
          <Inp label="Fee (basis points)" val={feeBps} set={setFeeBps} ph="30" />
        </div>
        <ABtn label="Create Pool" onClick={handleCreatePool} status={sec.pool.status} />
        <Err message={sec.pool.err} /><Ok message={sec.pool.ok} />
      </div>

      {/* ─── SECTION: Governance ─── */}
      <div className="glass rounded-xl p-4 border-amber-500/20">
        <h4 className="text-sm font-semibold text-amber-300 mb-3">Governance (Multi-Sig)</h4>
        {!currentSignerIndex && signerTrunc && (
          <div className="mb-3 p-3 rounded-lg bg-slate-500/10 border border-slate-500/20 text-slate-400 text-xs">
            ⚠️ Your wallet is not one of the 3 multi-sig signers. Governance actions require a signer wallet.
          </div>
        )}
        <p className="text-xs text-slate-500 mb-3">
          Sensitive actions require all 3 signers to approve: <strong>Propose → Approve (×3) → Execute</strong>.
        </p>

        {hasActiveProposal && (
          <div className="mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
            Active proposal: {proposalActionType}. Approvals: {approvalCount}/3.
            {proposedAt > 0 && (
              <span className="block mt-1 text-slate-500">Proposed at: {new Date(proposedAt * 1000).toLocaleString()}</span>
            )}
          </div>
        )}

        <div className={hasActiveProposal ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : "grid grid-cols-1 sm:grid-cols-3 gap-3"}>
          {!hasActiveProposal && (
            <button onClick={handleProposePause} disabled={sec.govPause.status === "sending" || currentSignerIndex === 0}
              className="p-3 rounded-xl glass glass-hover border-red-500/20 hover:border-red-400/40 text-left transition-all disabled:opacity-40">
              <div className="text-lg mb-1">📋</div>
              <div className="font-semibold text-red-400 text-xs sm:text-sm">Propose Pause</div>
              <div className="text-xs text-slate-500 mt-1">Submit a pause proposal</div>
            </button>
          )}
          {!hasActiveProposal && (
            <button onClick={async () => {
              // Propose Unpause
              if (!program || !provider || !pk) return;
              setSection("govPause", { err: "", ok: "", status: "sending" });
              try {
                const [sp] = getStatePda();
                const tx = await program.methods.proposeAction({ unpause: {} }, Buffer.from([])).accounts({ state: sp, admin: pk }).rpc();
                const myIdx = currentSignerIndex - 1;
                const newApproved = [false, false, false];
                if (myIdx >= 0) newApproved[myIdx] = true;
                setApprovedBy(newApproved);
                setApprovalCount(1);
                setHasActiveProposal(true);
                setProposalActionType("Unpause");
                setSection("govPause", { status: "confirmed", ok: `Unpause proposed! 1/3 approved.` });
              } catch (e) { setSection("govPause", { status: "error", err: parseErrorMessage(e) }); }
            }} disabled={sec.govPause.status === "sending" || currentSignerIndex === 0}
              className="p-3 rounded-xl glass glass-hover border-emerald-500/20 hover:border-emerald-400/40 text-left transition-all disabled:opacity-40">
              <div className="text-lg mb-1">📋</div>
              <div className="font-semibold text-emerald-400 text-xs sm:text-sm">Propose Unpause</div>
              <div className="text-xs text-slate-500 mt-1">Submit an unpause proposal</div>
            </button>
          )}
          {!hasActiveProposal && (
            <div className="p-3 rounded-xl glass border-purple-500/20 space-y-2">
              <div className="text-lg mb-1">⚡</div>
              <div className="font-semibold text-purple-400 text-xs sm:text-sm">Propose Reward Rate</div>
              <div className="text-xs text-slate-500">Set new staking reward rate (current: {rewardRate ?? "..."})</div>
              <Inp label="New Reward Rate" val={govRewardRate} set={setGovRewardRate} ph="e.g. 50" />
              <button onClick={async () => {
                if (!program || !provider || !pk) return;
                const r = parseInt(govRewardRate);
                if (isNaN(r) || r <= 0) { setSection("govPause", { err: "Enter a valid reward rate.", status: "error" }); return; }
                setSection("govPause", { err: "", ok: "", status: "sending" });
                try {
                  const rateBytes = Buffer.alloc(8);
                  rateBytes.writeBigUInt64LE(BigInt(r));
                  const [sp] = getStatePda();
                  const tx = await program.methods.proposeAction({ updateRewardRate: {} }, Buffer.from(rateBytes)).accounts({ state: sp, admin: pk }).rpc();
                  const myIdx = currentSignerIndex - 1;
                  const newApproved = [false, false, false];
                  if (myIdx >= 0) newApproved[myIdx] = true;
                  setApprovedBy(newApproved);
                  setApprovalCount(1);
                  setHasActiveProposal(true);
                  setProposalActionType("UpdateRewardRate");
                  setSection("govPause", { status: "confirmed", ok: `Reward rate ${r} proposed! 1/3 approved.` });
                } catch (e) { setSection("govPause", { status: "error", err: parseErrorMessage(e) }); }
              }} disabled={sec.govPause.status === "sending" || currentSignerIndex === 0 || !govRewardRate}
                className="w-full py-1.5 rounded-lg text-xs font-semibold bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 transition-all disabled:opacity-40">
                Submit Proposal
              </button>
            </div>
          )}

          {hasActiveProposal && proposalActionType === "UpdateRewardRate" && approvalCount === 3 && (
            <button onClick={async () => {
              if (!program || !provider || !pk) return;
              setSection("govApprove", { err: "", ok: "", status: "sending" });
              try {
                const [sp] = getStatePda();
                const tx = await (program as any).methods.updateRewardRate().accounts({ state: sp, admin: pk }).rpc();
                setSection("govApprove", { status: "confirmed", ok: `Reward rate updated! TX: ${tx.slice(0, 12)}...` });
                setApprovalCount(0); setApprovedBy([false, false, false]); setHasActiveProposal(false);
                await fetchProtocolState();
              } catch (e) { setSection("govApprove", { status: "error", err: parseErrorMessage(e) }); }
            }} disabled={sec.govApprove.status === "sending"}
              className="p-3 rounded-xl glass glow-amber border-purple-500/30 hover:border-purple-400/50 text-left transition-all">
              <div className="text-lg mb-1">⚡</div>
              <div className="font-semibold text-purple-400 text-xs sm:text-sm">Execute Reward Rate</div>
              <div className="text-xs text-slate-500 mt-1">All 3 signers approved</div>
            </button>
          )}

          {hasActiveProposal && approvalCount < 3 && !approvedBy[currentSignerIndex - 1] && (
            <button onClick={handleApprove} disabled={sec.govApprove.status === "sending" || currentSignerIndex === 0}
              className="p-3 rounded-xl glass glass-hover border-emerald-500/20 hover:border-emerald-400/40 text-left transition-all disabled:opacity-40">
              <div className="text-lg mb-1">✅</div>
              <div className="font-semibold text-emerald-400 text-xs sm:text-sm">Approve {proposalActionType}</div>
              <div className="text-xs text-slate-500 mt-1">Approve as Signer {currentSignerIndex}</div>
            </button>
          )}

          {hasActiveProposal && approvalCount === 3 && proposalActionType === "Pause" && (
            <button onClick={handleExecutePause} disabled={sec.govApprove.status === "sending"}
              className="p-3 rounded-xl glass glow-amber border-amber-500/30 hover:border-amber-400/50 text-left transition-all">
              <div className="text-lg mb-1">⏸️</div>
              <div className="font-semibold text-amber-400 text-xs sm:text-sm">Execute Pause</div>
              <div className="text-xs text-slate-500 mt-1">All 3 signers approved — ready to execute</div>
            </button>
          )}

          {hasActiveProposal && approvalCount === 3 && proposalActionType === "Unpause" && (
            <button onClick={handleExecuteUnpause} disabled={sec.govApprove.status === "sending"}
              className="p-3 rounded-xl glass glow-amber border-amber-500/30 hover:border-amber-400/50 text-left transition-all">
              <div className="text-lg mb-1">▶️</div>
              <div className="font-semibold text-amber-400 text-xs sm:text-sm">Execute Unpause</div>
              <div className="text-xs text-slate-500 mt-1">All 3 signers approved — ready to execute</div>
            </button>
          )}

          {!hasActiveProposal && (
            <div className="p-3 rounded-xl glass border-pink-500/20 space-y-2">
              <div className="text-lg mb-1">🔧</div>
              <div className="font-semibold text-pink-400 text-xs sm:text-sm">Propose Flash Loan CB</div>
              <div className="text-xs text-slate-500">Set flash loan callback program address</div>
              <InpTxt label="Callback Program Address" val={govFlCbAddr} set={setGovFlCbAddr} ph="Enter program base58 address" />
              <button onClick={async () => {
                if (!program || !provider || !pk) return;
                if (!govFlCbAddr || govFlCbAddr.length < 32) { setSection("govPause", { err: "Enter a valid program address.", status: "error" }); return; }
                setSection("govPause", { err: "", ok: "", status: "sending" });
                try {
                  const addrPk = new PublicKey(govFlCbAddr);
                  const [sp] = getStatePda();
                  const tx = await program.methods.proposeAction({ updateFlashLoanCallbackProgram: {} }, Buffer.from(addrPk.toBytes())).accounts({ state: sp, admin: pk }).rpc();
                  const myIdx = currentSignerIndex - 1;
                  const newApproved = [false, false, false];
                  if (myIdx >= 0) newApproved[myIdx] = true;
                  setApprovedBy(newApproved);
                  setApprovalCount(1);
                  setHasActiveProposal(true);
                  setProposalActionType("UpdateFlashLoanCallbackProgram");
                  setSection("govPause", { status: "confirmed", ok: `Flash Loan Callback proposal! 1/3 approved.` });
                } catch (e) { setSection("govPause", { status: "error", err: parseErrorMessage(e) }); }
              }} disabled={sec.govPause.status === "sending" || currentSignerIndex === 0 || !govFlCbAddr}
                className="w-full py-1.5 rounded-lg text-xs font-semibold bg-pink-500/10 border border-pink-500/20 text-pink-400 hover:bg-pink-500/20 transition-all disabled:opacity-40">
                Submit Proposal
              </button>
            </div>
          )}

          {hasActiveProposal && proposalActionType === "UpdateFlashLoanCallbackProgram" && approvalCount === 3 && (
            <button onClick={async () => {
              if (!program || !provider || !pk) return;
              setSection("govApprove", { err: "", ok: "", status: "sending" });
              try {
                const [sp] = getStatePda();
                const tx = await (program as any).methods.updateFlashLoanCallbackProgram().accounts({ state: sp, admin: pk }).rpc();
                setSection("govApprove", { status: "confirmed", ok: `Flash loan callback updated! TX: ${tx.slice(0, 12)}...` });
                setApprovalCount(0); setApprovedBy([false, false, false]); setHasActiveProposal(false);
                await fetchProtocolState();
              } catch (e) { setSection("govApprove", { status: "error", err: parseErrorMessage(e) }); }
            }} disabled={sec.govApprove.status === "sending"}
              className="p-3 rounded-xl glass glow-amber border-pink-500/30 hover:border-pink-400/50 text-left transition-all">
              <div className="text-lg mb-1">🔧</div>
              <div className="font-semibold text-pink-400 text-xs sm:text-sm">Execute Flash Loan CB</div>
              <div className="text-xs text-slate-500 mt-1">All 3 signers approved</div>
            </button>
          )}

          {hasActiveProposal && currentSignerIndex > 0 && (
            <button onClick={async () => {
              if (!program || !provider || !pk) return;
              setSection("govPause", { err: "", ok: "", status: "sending" });
              try {
                const [sp] = getStatePda();
                const tx = await program.methods.cancelAction().accounts({ state: sp, admin: pk }).rpc();
                setSection("govPause", { status: "confirmed", ok: `Proposal cancelled!` });
                setApprovalCount(0); setApprovedBy([false, false, false]); setHasActiveProposal(false);
              } catch (e) { setSection("govPause", { status: "error", err: parseErrorMessage(e) }); }
            }} disabled={sec.govPause.status === "sending"}
              className="p-3 rounded-xl glass glass-hover border-red-500/20 hover:border-red-400/40 text-left transition-all disabled:opacity-40">
              <div className="text-lg mb-1">🗑️</div>
              <div className="font-semibold text-red-400 text-xs sm:text-sm">Cancel Proposal</div>
              <div className="text-xs text-slate-500 mt-1">Abort the pending proposal</div>
            </button>
          )}
        </div>
        <div className="mt-2 space-y-1">
          <Err message={sec.govPause.err} /><Ok message={sec.govPause.ok} />
          <Err message={sec.govApprove.err} /><Ok message={sec.govApprove.ok} />
        </div>
      </div>

      {/* ─── LIVE PROTOCOL STATE ─── */}
      <div className="rounded-xl border border-sky-500/10 overflow-hidden">
        <div className="p-3 sm:p-4 bg-sky-500/5 border-b border-sky-500/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full animate-pulse bg-emerald-400" />
            <h4 className="text-sm font-semibold text-sky-300">Protocol State</h4>
          </div>
          <span className={`text-xs font-mono px-2 py-1 rounded-md ${
            protocolPaused === null ? "bg-slate-500/20 text-slate-400" :
            protocolPaused ? "bg-red-500/20 text-red-400" : "bg-emerald-500/20 text-emerald-400"
          }`}>
            {protocolPaused === null ? "Loading..." : protocolPaused ? "⏸ PAUSED" : "✅ ACTIVE"}
          </span>
        </div>
        <div className="p-3 sm:p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
          <KV label="Total Staked SOL" value={totalStakedSol ?? "—"} />
          <KV label="Total Staked USDC" value={totalStakedUsdc ?? "—"} />
          <KV label="SOL Vault" value={balSol !== null ? `${balSol} SOL` : "—"} />
          <KV label="USDC Vault" value={balUsdc !== null ? `${balUsdc} USDC` : "—"} />
          <KV label="Reward Rate" value={rewardRate ?? "—"} />
          <KV label="Rewards Distributed" value={totalRewardsDistributed !== null ? `${totalRewardsDistributed} SOL` : "—"} />
          <KV label="Reward Per Token" value={rewardPerTokenStored ?? "—"} />
          <KV label="Last Update" value={lastUpdateTime ?? "—"} />
          <KV label="Timelock Delay" value={timelockDelay ?? "—"} />
          <KV label="Required Signatures" value={requiredSignatures ?? "—"} />
          <KV label="Min Stake" value={minStakeAmt !== null ? `${minStakeAmt} SOL` : "—"} />
          <KV label="Protocol Fee" value={protocolFeeBps !== null ? `${protocolFeeBps} bps` : "—"} />
          <KV label="Flash Loan Callback" value={flashLoanCbProgram ?? "—"} />
          <KV label="Version" value={upgradeVersion ?? "—"} />
          <KV label="Pending Action" value={pendingActionInfo ?? "—"} accent={pendingActionInfo && pendingActionInfo !== "None" ? "text-amber-300" : undefined} />
          <KV label="SOL Vault PDA" value={(() => { try { return `${(getRewardVaultPda(0)[0]).toBase58().slice(0, 8)}...`; } catch { return "—"; } })()} />
          <KV label="USDC Vault PDA" value={(() => { try { return `${(getRewardVaultPda(1)[0]).toBase58().slice(0, 8)}...`; } catch { return "—"; } })()} />
          <KV label="USDC Mint" value={USDC_MINT.equals(PublicKey.default) ? "Not set" : `${USDC_MINT.toBase58().slice(0, 8)}...`} />
          <KV label="Pool PDA" value={(() => { try { return `${(getPoolPda(WSOL_MINT, USDC_MINT)[0]).toBase58().slice(0, 8)}...`; } catch { return "—"; } })()} />
        </div>
      </div>

      <div className="p-3 sm:p-4 rounded-xl bg-sky-500/5 border border-sky-500/10 text-sky-400/80 text-xs leading-relaxed">
        <strong>Setup Order:</strong> Initialize State → Initialize SOL → Initialize USDC → Fund Reward Vault → Create Pool. Governance uses: Propose Action → Approve Action (by all 3 signers) → automatic execution after timelock.
      </div>
    </div>
  );
}
