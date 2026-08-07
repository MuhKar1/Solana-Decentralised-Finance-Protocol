import type { Metadata } from "next";
import { SolanaProvider, WalletStatus } from "@/providers/solana-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeFi Protocol | Solana Devnet",
  description:
    "Multi-signature staking, AMM liquidity pools, and flash loans on Solana",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0a0f1e] text-slate-200 antialiased">
        <SolanaProvider>
          {/* Nav */}
          <nav className="fixed top-0 left-0 right-0 z-40 glass border-b border-sky-500/10">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-sky-500/20">
                  D
                </div>
                <h1 className="text-lg font-semibold text-gradient tracking-tight">
                  DeFi Protocol
                </h1>
              </div>
              <WalletStatus />
            </div>
          </nav>

          {/* Main content with padding for banners */}
          <main className="pt-16 pb-16">{children}</main>
        </SolanaProvider>
      </body>
    </html>
  );
}