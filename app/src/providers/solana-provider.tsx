"use client";

import React, { useMemo, useCallback } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TorusWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

const CLUSTER: WalletAdapterNetwork = WalletAdapterNetwork.Devnet;
const RPC_ENDPOINT = clusterApiUrl(CLUSTER);
const PROGRAM_ID = "FDwF1iC4FYJrAMK9ns7pSUjZdhaZRjQ857bsaQEyZ7B1";

export { PROGRAM_ID, CLUSTER, RPC_ENDPOINT };

export function SolanaProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new TorusWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export function WalletStatus() {
  const { wallet, publicKey, connected, connecting, disconnecting } =
    useWallet();
  const [copied, setCopied] = React.useState(false);

  const base58 = publicKey?.toBase58();
  const display = base58
    ? `${base58.slice(0, 4)}...${base58.slice(-4)}`
    : "";

  const copy = useCallback(() => {
    if (base58) {
      navigator.clipboard.writeText(base58);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [base58]);

  if (!connected) return null;

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {display && (
        <button
          onClick={copy}
          className="hidden sm:inline-flex px-3 py-1.5 rounded-lg bg-emerald-900/60 border border-emerald-700/50 text-emerald-300 text-xs font-mono hover:bg-emerald-900/80 transition"
          title="Click to copy full address"
        >
          {copied ? "Copied!" : display}
        </button>
      )}
      <WalletMultiButton />
    </div>
  );
}