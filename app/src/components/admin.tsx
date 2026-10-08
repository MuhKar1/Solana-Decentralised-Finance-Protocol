"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  createMintToInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  getStatePda,
  getStakingPoolPda,
  getRewardVaultPda,
  getTreasuryPda,
} from "@/lib/pda";
import {
  useInitializeState,
  usePropose,
  useApprove,
  useCancel,
  useExecute,
} from "@/hooks/use-governance";
import { useCreatePool } from "@/hooks/use-amm";
import { useTx } from "@/hooks/use-tx";
import { fetchProtocolState } from "@/hooks/use-protocol-data";
import { getUsdcMint, setUsdcMint, hasUsdcMint } from "@/lib/usdc-mint";
import { PYTH_SOL_FEED_PUBKEY, PYTH_USDC_FEED_PUBKEY } from "@/lib/oracle";
import { Inp, InpTxt, ABtn, Err, Ok, KV } from "@/components/ui";

function wrapSol(
  provider: any,
  owner: PublicKey,
  ata: PublicKey,
  lamports: number
) {
  const conn = provider.connection;
  return async () => {
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction()
      .add(
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports })
      )
      .add(createSyncNativeInstruction(ata));
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    await provider.sendAndConfirm(tx, []);
  };
}

async function ensureAta(
  provider: any,
  owner: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const conn = provider.connection;
  const info = await conn.getAccountInfo(ata);
  if (!info) {
    const { blockhash } = await conn.getLatestBlockhash();
    const ix = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    await provider.sendAndConfirm(tx, []);
  }
  return ata;
}

export function AdminPanel({
  program,
  provider,
}: {
  program: any;
  provider: any;
}) {
  const { publicKey: pk } = useWallet();
  const tx = useTx();

  const initState = useInitializeState(program, provider);
  const createPool = useCreatePool(program, provider, getUsdcMint());

  // Signer + state
  const [signer1, setS1] = useState("");
  const [signer2, setS2] = useState("");
  const [signer3, setS3] = useState("");
  const [timelock, setTimelock] = useState("86400");
  const [feeBps, setFeeBps] = useState("30");
  const [fundSolAmt, setFundSolAmt] = useState("");
  const [fundUsdcAmt, setFundUsdcAmt] = useState("");
  const [protocol, setProtocol] = useState<any>(null);
  const [signerFull, setSignerFull] = useState<{
    s1: string;
    s2: string;
    s3: string;
  } | null>(null);
  const [usdcReady, setUsdcReady] = useState(hasUsdcMint());

  const wsolMint = new PublicKey("So11111111111111111111111111111111111111112");

  const doInitializeState = useCallback(async () => {
    await tx.run(async () => {
      if (!signer1 || !signer2 || !signer3)
        throw new Error("All three signer public keys are required.");
      const s1 = new PublicKey(signer1);
      const s2 = new PublicKey(signer2);
      const s3 = new PublicKey(signer3);
      const tl = parseInt(timelock);
      if (isNaN(tl) || tl < 0)
        throw new Error("Timelock delay must be a positive number.");
      return initState(s1, s2, s3, new BN(tl));
    }, "State initialized!");
  }, [tx, initState, signer1, signer2, signer3, timelock]);

  const doInitializeSol = useCallback(async () => {
    await tx.run(async () => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const [sp] = getStatePda();
      const [stakingPoolSol] = getStakingPoolPda(0);
      const [rewardVaultSol] = getRewardVaultPda(0);
      const [treasurySol] = getTreasuryPda(wsolMint);
      return program.methods
        .initializeSolAccounts()
        .accounts({
          state: sp,
          stakingPoolSol,
          rewardVaultSol,
          protocolTreasurySol: treasurySol,
          solMint: wsolMint,
          authority: pk,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        })
        .rpc();
    }, "SOL accounts initialized!");
  }, [tx, program, provider, pk, wsolMint]);

  const doInitializeUsdc = useCallback(async () => {
    await tx.run(async () => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const conn = provider.connection;
      const [sp] = getStatePda();
      const [stakingPoolUsdc] = getStakingPoolPda(1);
      const existing = await conn.getAccountInfo(stakingPoolUsdc);

      let mint = getUsdcMint();
      if (existing && mint.equals(PublicKey.default)) {
        mint = new PublicKey(existing.data.slice(0, 32));
        setUsdcMint(mint);
      }
      if (mint.equals(PublicKey.default)) {
        const mintKp = new Keypair();
        const rent = await getMinimumBalanceForRentExemptMint(conn);
        const { blockhash } = await conn.getLatestBlockhash();
        const mintTx = new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: pk,
            newAccountPubkey: mintKp.publicKey,
            lamports: rent,
            space: MINT_SIZE,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(mintKp.publicKey, 6, pk, pk)
        );
        mintTx.feePayer = pk;
        mintTx.recentBlockhash = blockhash;
        await provider.sendAndConfirm(mintTx, [mintKp]);
        mint = mintKp.publicKey;
        setUsdcMint(mint);
      }

      if (!existing) {
        const [rewardVaultUsdc] = getRewardVaultPda(1);
        const [treasuryUsdc] = getTreasuryPda(mint);
        await program.methods
          .initializeUsdcAccounts()
          .accounts({
            state: sp,
            stakingPoolUsdc,
            rewardVaultUsdc,
            protocolTreasuryUsdc: treasuryUsdc,
            usdcMint: mint,
            authority: pk,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
          })
          .rpc();
      }

      const ata = await ensureAta(provider, pk, mint);
      const { blockhash } = await conn.getLatestBlockhash();
      const mintTx2 = new Transaction().add(
        createMintToInstruction(mint, ata, pk, BigInt("1000000000000"))
      );
      mintTx2.feePayer = pk;
      mintTx2.recentBlockhash = blockhash;
      await provider.sendAndConfirm(mintTx2, []);
      setUsdcReady(true);
      return "USDC initialized";
    }, "USDC accounts initialized + 1,000,000 USDC minted!");
  }, [tx, program, provider, pk]);

  const doFundSol = useCallback(async () => {
    await tx.run(async () => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const p = parseFloat(fundSolAmt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount.");
      const lamports = Math.floor(p * 1_000_000_000);
      const [sp] = getStatePda();
      const [rv] = getRewardVaultPda(0);
      const ata = await ensureAta(provider, pk, wsolMint);
      await wrapSol(provider, pk, ata, lamports)();
      return program.methods
        .fundRewardVault(new BN(lamports), 0)
        .accounts({
          authority: pk,
          authorityTokenAccount: ata,
          rewardVault: rv,
          stakeMint: wsolMint,
          state: sp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }, "SOL vault funded!");
  }, [tx, program, provider, pk, fundSolAmt, wsolMint]);

  const doFundUsdc = useCallback(async () => {
    await tx.run(async () => {
      if (!program || !provider || !pk) throw new Error("Wallet not connected");
      const p = parseFloat(fundUsdcAmt);
      if (isNaN(p) || p <= 0) throw new Error("Enter a valid positive amount.");
      const raw = new BN(Math.floor(p * 1_000_000));
      const mint = getUsdcMint();
      if (mint.equals(PublicKey.default))
        throw new Error("Initialize USDC accounts first.");
      const [sp] = getStatePda();
      const [rv] = getRewardVaultPda(1);
      const ata = await ensureAta(provider, pk, mint);
      // Mint enough if low.
      const info = await provider.connection.getAccountInfo(ata);
      const bal =
        info && info.data.length >= 72
          ? new DataView(
              info.data.buffer,
              info.data.byteOffset + 64,
              8
            ).getBigUint64(0, true)
          : BigInt(0);
      if (bal < BigInt(raw.toString())) {
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const mintTx = new Transaction().add(
          createMintToInstruction(mint, ata, pk, BigInt("1000000000000"))
        );
        mintTx.feePayer = pk;
        mintTx.recentBlockhash = blockhash;
        await provider.sendAndConfirm(mintTx, []);
      }
      return program.methods
        .fundRewardVault(raw, 1)
        .accounts({
          authority: pk,
          authorityTokenAccount: ata,
          rewardVault: rv,
          stakeMint: mint,
          state: sp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }, "USDC vault funded!");
  }, [tx, program, provider, pk, fundUsdcAmt]);

  const doCreatePool = useCallback(async () => {
    await tx.run(async () => {
      const fee = parseInt(feeBps);
      if (isNaN(fee) || fee < 0 || fee > 1000)
        throw new Error("Fee must be 0-1000 basis points.");
      return createPool(fee);
    }, "Pool created!");
  }, [tx, createPool, feeBps]);

  // Governance approval flow
  const propose = usePropose(program, provider);
  const approve = useApprove(program, provider);
  const cancel = useCancel(program, provider);
  const execute = useExecute(program, provider);
  const [govRewardRate, setGovRewardRate] = useState("50");

  const doProposePause = useCallback(async () => {
    await tx.run(
      () => propose({ pause: {} }, Buffer.alloc(0)),
      "Pause proposed!"
    );
  }, [tx, propose]);

  const doProposeUnpause = useCallback(async () => {
    await tx.run(
      () => propose({ unpause: {} }, Buffer.alloc(0)),
      "Unpause proposed!"
    );
  }, [tx, propose]);

  const doProposeRewardRate = useCallback(async () => {
    await tx.run(() => {
      const r = parseInt(govRewardRate);
      if (isNaN(r) || r <= 0) throw new Error("Enter a valid reward rate.");
      const rateBytes = Buffer.alloc(8);
      rateBytes.writeBigUInt64LE(BigInt(r));
      return propose({ updateRewardRate: {} }, Buffer.from(rateBytes));
    }, "Reward rate proposed!");
  }, [tx, propose, govRewardRate]);

  const doApprove = useCallback(async () => {
    await tx.run(approve, "Approved!");
  }, [tx, approve]);

  const doCancel = useCallback(async () => {
    await tx.run(cancel, "Proposal cancelled!");
  }, [tx, cancel]);

  const doExecute = useCallback(
    async (method: string) => {
      await tx.run(() => execute(method), "Executed!");
    },
    [tx, execute]
  );

  // Live protocol state
  const loadState = useCallback(async () => {
    if (!provider) return;
    const s = await fetchProtocolState(provider, getUsdcMint());
    setProtocol(s);
    const [sp] = getStatePda();
    const info = await provider.connection.getAccountInfo(sp);
    if (info && info.data.length >= 136) {
      setSignerFull({
        s1: new PublicKey(info.data.slice(40, 72)).toBase58(),
        s2: new PublicKey(info.data.slice(72, 104)).toBase58(),
        s3: new PublicKey(info.data.slice(104, 136)).toBase58(),
      });
    }
  }, [provider]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const currentSignerIndex =
    signerFull && pk
      ? pk.toBase58() === signerFull.s1
        ? 1
        : pk.toBase58() === signerFull.s2
        ? 2
        : pk.toBase58() === signerFull.s3
        ? 3
        : 0
      : 0;

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h3 className="text-base sm:text-lg font-semibold text-amber-400">
          Admin Controls
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
          Protocol initialization and multi-sig governance.
        </p>
      </div>

      <Section title="1. Initialize Program State">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <InpTxt label="Signer 1 (Pubkey)" val={signer1} set={setS1} />
          <InpTxt label="Signer 2 (Pubkey)" val={signer2} set={setS2} />
          <InpTxt label="Signer 3 (Pubkey)" val={signer3} set={setS3} />
          <Inp
            label="Timelock Delay (seconds)"
            val={timelock}
            set={setTimelock}
            ph="86400"
          />
        </div>
        <ABtn
          label="Initialize State"
          onClick={doInitializeState}
          status={tx.status}
          disabled={!signer1 || !signer2 || !signer3}
        />
      </Section>

      <Section title="2. Initialize SOL Accounts">
        <ABtn
          label="Initialize SOL Accounts"
          onClick={doInitializeSol}
          status={tx.status}
        />
      </Section>

      <Section title="3. Initialize USDC Accounts">
        <p className="text-xs text-slate-500 mb-2">
          {usdcReady
            ? `USDC mint: ${getUsdcMint().toBase58().slice(0, 8)}...`
            : "Creates USDC mint + PDA accounts, then mints test USDC to your wallet."}
        </p>
        <ABtn
          label="Initialize USDC Accounts"
          onClick={doInitializeUsdc}
          status={tx.status}
        />
      </Section>

      <Section title="Fund Reward Vaults">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <Inp label="SOL amount" val={fundSolAmt} set={setFundSolAmt} />
          <Inp label="USDC amount" val={fundUsdcAmt} set={setFundUsdcAmt} />
        </div>
        <div className="flex gap-2">
          <button
            onClick={doFundSol}
            className="flex-1 py-2 rounded-xl text-xs font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Fund SOL Vault
          </button>
          <button
            onClick={doFundUsdc}
            className="flex-1 py-2 rounded-xl text-xs font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Fund USDC Vault
          </button>
        </div>
      </Section>

      <Section title="5. Create Liquidity Pool">
        <Inp label="Fee (basis points)" val={feeBps} set={setFeeBps} ph="30" />
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">
            Pyth feed accounts embedded in this pool
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              Feed A (SOL/USD)
            </span>
            <span
              className="font-mono text-xs text-emerald-300"
              title={PYTH_SOL_FEED_PUBKEY.toBase58()}
            >
              {PYTH_SOL_FEED_PUBKEY.toBase58().slice(0, 6)}…
              {PYTH_SOL_FEED_PUBKEY.toBase58().slice(-6)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              Feed B (USDC/USD)
            </span>
            <span
              className="font-mono text-xs text-emerald-300"
              title={PYTH_USDC_FEED_PUBKEY.toBase58()}
            >
              {PYTH_USDC_FEED_PUBKEY.toBase58().slice(0, 6)}…
              {PYTH_USDC_FEED_PUBKEY.toBase58().slice(-6)}
            </span>
          </div>
        </div>
        <div className="mt-3">
          <ABtn label="Create Pool" onClick={doCreatePool} status={tx.status} />
        </div>
      </Section>

      <Section title="Governance (Multi-Sig)">
        {currentSignerIndex === 0 && signerFull && (
          <div className="mb-3 p-3 rounded-lg bg-slate-500/10 border border-slate-500/20 text-slate-400 text-xs">
            ⚠️ Your wallet is not one of the 3 multi-sig signers.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={doProposePause}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Propose Pause
          </button>
          <button
            onClick={doProposeUnpause}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Propose Unpause
          </button>
          <button
            onClick={doApprove}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Approve
          </button>
          <button
            onClick={doCancel}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Cancel
          </button>
          <button
            onClick={() => doExecute("pause")}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Execute Pause
          </button>
          <button
            onClick={() => doExecute("unpause")}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all"
            disabled={tx.status !== "idle"}
          >
            Execute Unpause
          </button>
        </div>
        <div className="mt-3 flex gap-2 items-center">
          <Inp
            label="New Reward Rate"
            val={govRewardRate}
            set={setGovRewardRate}
          />
          <div className="pt-5">
            <button
              onClick={doProposeRewardRate}
              className="px-3 py-2 rounded-xl text-xs font-semibold bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 transition-all"
              disabled={tx.status !== "idle"}
            >
              Propose Rate
            </button>
          </div>
        </div>
      </Section>

      {protocol && (
        <Section title="Live Protocol State">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <KV
              label="Paused"
              value={
                protocol.paused === null
                  ? "—"
                  : protocol.paused
                  ? "⏸ PAUSED"
                  : "✅ ACTIVE"
              }
            />
            <KV label="Reward Rate" value={protocol.rewardRate ?? "—"} />
            <KV
              label="Total Staked SOL"
              value={protocol.totalStakedSol ?? "—"}
            />
            <KV
              label="Total Staked USDC"
              value={protocol.totalStakedUsdc ?? "—"}
            />
            <KV
              label="SOL Vault"
              value={
                protocol.solVault !== null ? `${protocol.solVault} SOL` : "—"
              }
            />
            <KV
              label="USDC Vault"
              value={
                protocol.usdcVault !== null ? `${protocol.usdcVault} USDC` : "—"
              }
            />
            <KV label="Timelock" value={protocol.timelockDelay ?? "—"} />
            <KV
              label="Required Sigs"
              value={protocol.requiredSignatures ?? "—"}
            />
            <KV label="Min Stake" value={protocol.minStakeAmt ?? "—"} />
          </div>
          <button
            onClick={loadState}
            className="mt-3 px-3 py-2 rounded-xl text-xs font-semibold bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 transition-all"
          >
            ↻ Refresh
          </button>
        </Section>
      )}

      <Err message={tx.error} />
      <Ok message={tx.ok} />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-xl p-4 border-amber-500/10">
      <h4 className="text-sm font-semibold text-amber-300 mb-2">{title}</h4>
      {children}
    </div>
  );
}
