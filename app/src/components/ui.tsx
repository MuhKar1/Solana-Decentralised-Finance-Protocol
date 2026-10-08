"use client";

import type { TxStatus } from "@/lib/constants";

export function TS({
  value,
  onChange,
}: {
  value: 0 | 1;
  onChange: (t: 0 | 1) => void;
}) {
  return (
    <div className="flex gap-2">
      {([0, 1] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            value === t
              ? "bg-sky-500/20 border border-sky-400/40 text-sky-300"
              : "glass text-slate-500 hover:text-slate-300"
          }`}
        >
          {t === 0 ? "SOL" : "USDC"}
        </button>
      ))}
    </div>
  );
}

const TX_STATUS_LABEL: Record<TxStatus, string> = {
  idle: "",
  signing: "Waiting for signature…",
  submitting: "Submitting…",
  confirming: "Confirming…",
  confirmed: "✓ Confirmed",
  failed: "Failed",
};

export function ABtn({
  label,
  onClick,
  status,
  disabled,
}: {
  label: string;
  onClick: () => void;
  status: TxStatus;
  disabled?: boolean;
}) {
  const loading =
    status === "signing" || status === "submitting" || status === "confirming";
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="w-full py-2.5 sm:py-3 rounded-xl font-semibold text-xs sm:text-sm transition-all bg-gradient-to-r from-sky-500 to-indigo-500 text-white hover:from-sky-400 hover:to-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-sky-500/20"
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {TX_STATUS_LABEL[status]}
        </span>
      ) : (
        TX_STATUS_LABEL[status] || label
      )}
    </button>
  );
}

export function Err({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="p-3 sm:p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs sm:text-sm animate-fade-in break-words">
      <span className="font-semibold">Error: </span>
      {message}
    </div>
  );
}

export function Ok({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="p-3 sm:p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs sm:text-sm animate-fade-in break-words">
      {message}
    </div>
  );
}

export function Inp({
  label,
  val,
  set,
  ph,
}: {
  label: string;
  val: string;
  set: (v: string) => void;
  ph?: string;
}) {
  return (
    <div>
      <label className="text-xs text-slate-400 uppercase tracking-wider block mb-1.5">
        {label}
      </label>
      <input
        type="number"
        step="any"
        min="0"
        placeholder={ph ?? "0.0"}
        value={val}
        onChange={(e) => set(e.target.value)}
        className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl glass border border-sky-500/10 focus:border-sky-400/40 focus:outline-none focus:ring-2 focus:ring-sky-500/10 text-slate-200 placeholder:text-slate-600 font-mono text-sm"
      />
    </div>
  );
}

export function InpTxt({
  label,
  val,
  set,
  ph,
}: {
  label: string;
  val: string;
  set: (v: string) => void;
  ph?: string;
}) {
  return (
    <div>
      <label className="text-xs text-slate-400 uppercase tracking-wider block mb-1.5">
        {label}
      </label>
      <input
        type="text"
        placeholder={ph ?? ""}
        value={val}
        onChange={(e) => set(e.target.value)}
        className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl glass border border-sky-500/10 focus:border-sky-400/40 focus:outline-none focus:ring-2 focus:ring-sky-500/10 text-slate-200 placeholder:text-slate-600 font-mono text-sm"
      />
    </div>
  );
}

export function SC({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-xl p-3 sm:p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-xs sm:text-sm text-slate-300 font-mono mt-1 break-all">
        {value}
      </p>
    </div>
  );
}

export function KV({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="glass rounded-lg p-2 sm:p-3">
      <p className="text-[10px] sm:text-xs text-slate-500 uppercase tracking-wider">
        {label}
      </p>
      <p
        className={`text-xs sm:text-sm font-mono mt-0.5 break-all ${
          accent ?? "text-slate-300"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export function FC({
  emoji,
  title,
  desc,
}: {
  emoji: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="glass rounded-xl p-3 sm:p-4 border-sky-500/10">
      <div className="text-xl sm:text-2xl mb-1">{emoji}</div>
      <h3 className="font-semibold text-xs sm:text-sm text-sky-300">{title}</h3>
      <p className="text-xs text-slate-500 mt-1 leading-relaxed">{desc}</p>
    </div>
  );
}
