import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { Defi } from "../target/types/defi";
import { Clock } from "solana-bankrun";

const IDL = require("../target/idl/defi.json");
const PROGRAM_ID = new PublicKey(IDL.address);

// A program id for the mock flash-loan callback program. The .so is built from
// tests/mock-programs/mock-flash-callback and copied to
// target/deploy/mock_flash_callback.so.
const MOCK_CALLBACK_PROGRAM_ID = Keypair.generate().publicKey;

const MIN_STAKE = 1_000_000_000; // 1 SOL (also 1,000 USDC raw units)

function pda(
  programId: PublicKey,
  seeds: Array<Buffer | Uint8Array>
): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function u64buf(value: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

function getErrorText(error: any): string {
  const logs: string[] = Array.isArray(error?.logs) ? error.logs : [];
  return [String(error?.message ?? ""), logs.join("\n")].join("\n");
}

function getErrorCode(error: any): string {
  const m = getErrorText(error).match(/Error Code:\s*([A-Za-z0-9_]+)/);
  return m ? m[1].toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Inline bankrun SPL-token helpers (avoids the unbuilt spl-token-bankrun dist).
// ---------------------------------------------------------------------------
let banksClient: any;
let banksClientAdmin!: Keypair;

async function createMint(decimals: number): Promise<PublicKey> {
  const mint = Keypair.generate();
  const rent = await banksClient.getRent();
  const lamports = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: banksClientAdmin.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mint.publicKey,
      decimals,
      banksClientAdmin.publicKey,
      null,
      TOKEN_PROGRAM_ID
    )
  );
  tx.recentBlockhash = (await banksClient.getLatestBlockhash())![0];
  tx.sign(banksClientAdmin, mint);
  await banksClient.processTransaction(tx);
  return mint.publicKey;
}

async function createAta(
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      banksClientAdmin.publicKey,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  tx.recentBlockhash = (await banksClient.getLatestBlockhash())![0];
  tx.sign(banksClientAdmin);
  await banksClient.processTransaction(tx);
  return ata;
}

async function mintTo(
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint
): Promise<void> {
  const tx = new Transaction().add(
    createMintToInstruction(
      mint,
      destination,
      banksClientAdmin.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  tx.recentBlockhash = (await banksClient.getLatestBlockhash())![0];
  tx.sign(banksClientAdmin);
  await banksClient.processTransaction(tx);
}

async function tokenBalance(ata: PublicKey): Promise<bigint> {
  const info = await banksClient.getAccount(ata);
  if (!info) throw new Error(`No account at ${ata.toBase58()}`);
  const acc = unpackAccount(ata, info as any, TOKEN_PROGRAM_ID);
  return acc.amount;
}

describe("Duplicate multisig signer guard", () => {
  it("rejects duplicate signers during initialize_state", async () => {
    const context = await startAnchor(
      "",
      [{ name: "de_fi", programId: PROGRAM_ID }],
      []
    );
    const provider = new BankrunProvider(context);
    const program = new anchor.Program<Defi>(IDL as any, provider);

    const admin = context.payer;
    const s1 = Keypair.generate().publicKey;
    const s2 = Keypair.generate().publicKey;
    const statePda = pda(PROGRAM_ID, [Buffer.from("state")]);

    try {
      await program.methods
        .initializeState(s1, s1, s2, new anchor.BN(2))
        .accountsPartial({
          state: statePda,
          authority: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed with DuplicateSigner");
    } catch (error: any) {
      expect(getErrorCode(error)).to.equal("duplicatesigner");
    }
  });
});

describe("DeFi edge-case tests (bankrun)", () => {
  let context: Awaited<ReturnType<typeof startAnchor>>;
  let provider: BankrunProvider;
  let program: anchor.Program<Defi>;

  let admin: Keypair;

  const signer1 = Keypair.generate();
  const signer2 = Keypair.generate();
  const signer3 = Keypair.generate();

  let solMint: PublicKey;
  let usdcMint: PublicKey;

  let adminSolAta: PublicKey;
  let adminUsdcAta: PublicKey;

  let statePda: PublicKey;
  let rewardVaultSol: PublicKey;
  let rewardVaultUsdc: PublicKey;
  let stakingPoolSol: PublicKey;
  let stakingPoolUsdc: PublicKey;

  // AMM (main pool)
  let tokenA: PublicKey;
  let tokenB: PublicKey;
  let adminAtaA: PublicKey;
  let adminAtaB: PublicKey;
  let poolPda: PublicKey;
  let poolTokenA: PublicKey;
  let poolTokenB: PublicKey;
  let lpTokenMint: PublicKey;
  let lpLockAccount: PublicKey;
  let adminLpAta: PublicKey;

  async function advanceTime(seconds: number) {
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + BigInt(seconds)
      )
    );
  }

  async function newFundedUser(): Promise<Keypair> {
    const u = Keypair.generate();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: u.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    tx.recentBlockhash = (await context.banksClient.getLatestBlockhash())![0];
    tx.sign(admin);
    await context.banksClient.processTransaction(tx);
    return u;
  }

  async function executeGovernance(
    actionType: any,
    data: Buffer,
    executor: () => Promise<any>
  ): Promise<void> {
    await program.methods
      .proposeAction(actionType, data)
      .accountsPartial({ state: statePda, admin: signer1.publicKey })
      .signers([signer1])
      .rpc();
    await program.methods
      .approveAction()
      .accountsPartial({ state: statePda, admin: signer2.publicKey })
      .signers([signer2])
      .rpc();
    await program.methods
      .approveAction()
      .accountsPartial({ state: statePda, admin: signer3.publicKey })
      .signers([signer3])
      .rpc();
    await advanceTime(3);
    await executor();
  }

  before(async () => {
    context = await startAnchor(
      "",
      [
        { name: "de_fi", programId: PROGRAM_ID },
        { name: "mock_flash_callback", programId: MOCK_CALLBACK_PROGRAM_ID },
      ],
      []
    );
    provider = new BankrunProvider(context);
    program = new anchor.Program<Defi>(IDL as any, provider);
    admin = context.payer;
    banksClientAdmin = admin;
    banksClient = context.banksClient;

    // Mints
    solMint = await createMint(9);
    usdcMint = await createMint(6);

    statePda = pda(PROGRAM_ID, [Buffer.from("state")]);
    stakingPoolSol = pda(PROGRAM_ID, [Buffer.from("staking_pool_sol")]);
    stakingPoolUsdc = pda(PROGRAM_ID, [Buffer.from("staking_pool_usdc")]);
    rewardVaultSol = pda(PROGRAM_ID, [Buffer.from("reward_vault_sol")]);
    rewardVaultUsdc = pda(PROGRAM_ID, [Buffer.from("reward_vault_usdc")]);

    const protocolTreasurySol = pda(PROGRAM_ID, [
      Buffer.from("protocol_treasury"),
      solMint.toBuffer(),
    ]);
    const protocolTreasuryUsdc = pda(PROGRAM_ID, [
      Buffer.from("protocol_treasury"),
      usdcMint.toBuffer(),
    ]);

    adminSolAta = await createAta(solMint, admin.publicKey);
    adminUsdcAta = await createAta(usdcMint, admin.publicKey);

    // Initialize protocol
    await program.methods
      .initializeState(
        signer1.publicKey,
        signer2.publicKey,
        signer3.publicKey,
        new anchor.BN(2)
      )
      .accountsPartial({
        state: statePda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .initializeSolAccounts()
      .accountsPartial({
        state: statePda,
        stakingPoolSol,
        rewardVaultSol,
        protocolTreasurySol,
        solMint,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .initializeUsdcAccounts()
      .accountsPartial({
        state: statePda,
        stakingPoolUsdc,
        rewardVaultUsdc,
        protocolTreasuryUsdc,
        usdcMint,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Mint generous balances to admin and fund reward vaults.
    const FUND = 1_000_000_000_000n; // 1_000 SOL / 1_000_000 USDC raw units
    await mintTo(solMint, adminSolAta, FUND * 3n);
    await mintTo(usdcMint, adminUsdcAta, FUND * 3n);

    await program.methods
      .fundRewardVault(new anchor.BN(FUND.toString()), 0)
      .accountsPartial({
        authority: admin.publicKey,
        authorityTokenAccount: adminSolAta,
        rewardVault: rewardVaultSol,
        stakeMint: solMint,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .fundRewardVault(new anchor.BN(FUND.toString()), 1)
      .accountsPartial({
        authority: admin.publicKey,
        authorityTokenAccount: adminUsdcAta,
        rewardVault: rewardVaultUsdc,
        stakeMint: usdcMint,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // Create the main AMM pool and add liquidity.
    [tokenA, tokenB] = sortMints(solMint, usdcMint);
    if (tokenA.equals(solMint)) {
      adminAtaA = adminSolAta;
      adminAtaB = adminUsdcAta;
    } else {
      adminAtaA = adminUsdcAta;
      adminAtaB = adminSolAta;
    }

    poolPda = pda(PROGRAM_ID, [
      Buffer.from("pool"),
      tokenA.toBuffer(),
      tokenB.toBuffer(),
    ]);
    poolTokenA = pda(PROGRAM_ID, [
      Buffer.from("pool_token_a"),
      poolPda.toBuffer(),
    ]);
    poolTokenB = pda(PROGRAM_ID, [
      Buffer.from("pool_token_b"),
      poolPda.toBuffer(),
    ]);
    lpTokenMint = pda(PROGRAM_ID, [
      Buffer.from("lp_token_mint"),
      poolPda.toBuffer(),
    ]);
    lpLockAccount = pda(PROGRAM_ID, [
      Buffer.from("lp_lock_account"),
      poolPda.toBuffer(),
    ]);

    await program.methods
      .createPool(30, PublicKey.default, PublicKey.default)
      .accountsPartial({
        pool: poolPda,
        tokenAMint: tokenA,
        tokenBMint: tokenB,
        tokenAAccount: poolTokenA,
        tokenBAccount: poolTokenB,
        lpTokenMint,
        lpLockAccount,
        state: statePda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    adminLpAta = await createAta(lpTokenMint, admin.publicKey);

    const liqA = new anchor.BN(10_000_000_000);
    const liqB = new anchor.BN(10_000_000_000);
    await program.methods
      .addLiquidity(liqA, liqB, new anchor.BN(1))
      .accountsPartial({
        user: admin.publicKey,
        userTokenA: adminAtaA,
        userTokenB: adminAtaB,
        userLpTokenAccount: adminLpAta,
        pool: poolPda,
        poolTokenA,
        poolTokenB,
        lpTokenMint,
        lpLockAccount,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Configure the flash-loan callback program via multisig governance.
    await executeGovernance(
      { updateFlashLoanCallbackProgram: {} },
      MOCK_CALLBACK_PROGRAM_ID.toBuffer(),
      () =>
        program.methods
          .updateFlashLoanCallbackProgram()
          .accountsPartial({ state: statePda, admin: signer1.publicKey })
          .signers([signer1])
          .rpc()
    );
  });

  it("rejects funding the SOL reward vault with USDC tokens", async () => {
    try {
      await program.methods
        .fundRewardVault(new anchor.BN(1_000_000), 0)
        .accountsPartial({
          authority: admin.publicKey,
          authorityTokenAccount: adminUsdcAta, // wrong mint (USDC)
          rewardVault: rewardVaultSol,
          stakeMint: solMint,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("Funding SOL vault with USDC should fail");
    } catch (error: any) {
      expect(getErrorCode(error)).to.include("constraint");
    }
  });

  it("accrues SOL and USDC staking rewards independently (cross-asset)", async () => {
    const user = await newFundedUser();
    const userSolAta = await createAta(solMint, user.publicKey);
    const userUsdcAta = await createAta(usdcMint, user.publicKey);

    await mintTo(solMint, userSolAta, BigInt(MIN_STAKE * 2));
    await mintTo(usdcMint, userUsdcAta, BigInt(MIN_STAKE * 2));

    const userStakeSol = pda(PROGRAM_ID, [
      Buffer.from("user_stake"),
      user.publicKey.toBuffer(),
      Buffer.from([0]),
    ]);
    const userStakeUsdc = pda(PROGRAM_ID, [
      Buffer.from("user_stake"),
      user.publicKey.toBuffer(),
      Buffer.from([1]),
    ]);

    await program.methods
      .stake(new anchor.BN(MIN_STAKE * 2), 0)
      .accountsPartial({
        user: user.publicKey,
        userTokenAccount: userSolAta,
        stakingPool: stakingPoolSol,
        state: statePda,
        userStake: userStakeSol,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await program.methods
      .stake(new anchor.BN(MIN_STAKE * 2), 1)
      .accountsPartial({
        user: user.publicKey,
        userTokenAccount: userUsdcAta,
        stakingPool: stakingPoolUsdc,
        state: statePda,
        userStake: userStakeUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await advanceTime(10);

    await program.methods
      .updateRewards(0)
      .accountsPartial({
        user: user.publicKey,
        state: statePda,
        userStake: userStakeSol,
      })
      .signers([user])
      .rpc();

    await program.methods
      .updateRewards(1)
      .accountsPartial({
        user: user.publicKey,
        state: statePda,
        userStake: userStakeUsdc,
      })
      .signers([user])
      .rpc();

    const solStake = await program.account.userStake.fetch(userStakeSol);
    const usdcStake = await program.account.userStake.fetch(userStakeUsdc);

    expect(solStake.pendingRewards.toNumber()).to.be.greaterThan(0);
    expect(usdcStake.pendingRewards.toNumber()).to.be.greaterThan(0);
  });

  it("claims rewards after a long idle period at a high reward rate without overflow", async () => {
    const user = await newFundedUser();
    const userSolAta = await createAta(solMint, user.publicKey);
    await mintTo(solMint, userSolAta, BigInt(MIN_STAKE * 2));

    await executeGovernance({ updateRewardRate: {} }, u64buf(1_000_000), () =>
      program.methods
        .updateRewardRate()
        .accountsPartial({ state: statePda, admin: signer1.publicKey })
        .signers([signer1])
        .rpc()
    );

    const userStakeSol = pda(PROGRAM_ID, [
      Buffer.from("user_stake"),
      user.publicKey.toBuffer(),
      Buffer.from([0]),
    ]);

    await program.methods
      .stake(new anchor.BN(MIN_STAKE * 2), 0)
      .accountsPartial({
        user: user.publicKey,
        userTokenAccount: userSolAta,
        stakingPool: stakingPoolSol,
        state: statePda,
        userStake: userStakeSol,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await advanceTime(200_000);

    await program.methods
      .updateRewards(0)
      .accountsPartial({
        user: user.publicKey,
        state: statePda,
        userStake: userStakeSol,
      })
      .signers([user])
      .rpc();

    const before = await program.account.userStake.fetch(userStakeSol);
    expect(before.pendingRewards.toNumber()).to.be.greaterThan(0);

    await program.methods
      .claimRewards(0)
      .accountsPartial({
        user: user.publicKey,
        userRewardTokenAccount: userSolAta,
        rewardVaultSol,
        rewardVaultUsdc,
        state: statePda,
        userStake: userStakeSol,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const after = await program.account.userStake.fetch(userStakeSol);
    expect(after.pendingRewards.toNumber()).to.equal(0);
  });

  it("reverts a swap on an empty pool (zero liquidity)", async () => {
    const m0 = await createMint(9);
    const m1 = await createMint(9);
    const [ta, tb] = sortMints(m0, m1);

    const ataA = await createAta(ta, admin.publicKey);
    const ataB = await createAta(tb, admin.publicKey);
    await mintTo(ta, ataA, 1_000_000n);

    const np = pda(PROGRAM_ID, [
      Buffer.from("pool"),
      ta.toBuffer(),
      tb.toBuffer(),
    ]);
    const npa = pda(PROGRAM_ID, [Buffer.from("pool_token_a"), np.toBuffer()]);
    const npb = pda(PROGRAM_ID, [Buffer.from("pool_token_b"), np.toBuffer()]);
    const nlpMint = pda(PROGRAM_ID, [
      Buffer.from("lp_token_mint"),
      np.toBuffer(),
    ]);
    const nlpLock = pda(PROGRAM_ID, [
      Buffer.from("lp_lock_account"),
      np.toBuffer(),
    ]);

    await program.methods
      .createPool(30, PublicKey.default, PublicKey.default)
      .accountsPartial({
        pool: np,
        tokenAMint: ta,
        tokenBMint: tb,
        tokenAAccount: npa,
        tokenBAccount: npb,
        lpTokenMint: nlpMint,
        lpLockAccount: nlpLock,
        state: statePda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    try {
      await program.methods
        .swap(new anchor.BN(1_000_000), new anchor.BN(0))
        .accountsPartial({
          user: admin.publicKey,
          userTokenIn: ataA,
          userTokenOut: ataB,
          pool: np,
          poolTokenA: npa,
          poolTokenB: npb,
          tokenIn: ta,
          tokenOut: tb,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          pythPriceA: PublicKey.default,
          pythPriceB: PublicKey.default,
        })
        .signers([admin])
        .rpc();
      expect.fail("Swap with zero liquidity should fail");
    } catch (error: any) {
      const code = getErrorCode(error);
      expect(code === "excessiveswapamount" || code === "overflow").to.equal(
        true
      );
    }
  });

  it("reverts removing liquidity with a zero LP amount", async () => {
    try {
      await program.methods
        .removeLiquidity(new anchor.BN(0), new anchor.BN(0), new anchor.BN(0))
        .accountsPartial({
          user: admin.publicKey,
          userTokenA: adminAtaA,
          userTokenB: adminAtaB,
          userLpTokenAccount: adminLpAta,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          lpTokenMint,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("Removing zero LP should fail");
    } catch (error: any) {
      expect(getErrorCode(error)).to.equal("invalidamount");
    }
  });

  it("reverts attempting to burn the permanently-locked LP liquidity", async () => {
    try {
      await program.methods
        .removeLiquidity(new anchor.BN(1), new anchor.BN(0), new anchor.BN(0))
        .accountsPartial({
          user: admin.publicKey,
          userTokenA: adminAtaA,
          userTokenB: adminAtaB,
          // Point the burn at the PDA-owned lock account, which the user
          // cannot sign for.
          userLpTokenAccount: lpLockAccount,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          lpTokenMint,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("Burning locked LP should fail");
    } catch (error: any) {
      const text = getErrorText(error).toLowerCase();
      expect(
        text.includes("owner") ||
          text.includes("mismatch") ||
          text.includes("constraint")
      ).to.equal(true);
    }
  });

  it("reverts a flash loan whose callback does not repay the funds", async () => {
    const beforeVault = await tokenBalance(poolTokenA);
    const beforeBorrower = await tokenBalance(adminAtaA);

    try {
      await program.methods
        .flashLoan(new anchor.BN(1_000_000), MOCK_CALLBACK_PROGRAM_ID)
        .accountsPartial({
          borrower: admin.publicKey,
          borrowerTokenAccount: adminAtaA,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts([
          {
            pubkey: MOCK_CALLBACK_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
        ])
        .signers([admin])
        .rpc();
      expect.fail("Flash loan with non-repaying callback should fail");
    } catch (error: any) {
      expect(getErrorCode(error)).to.equal("flashloannotrepaid");
    }

    expect(await tokenBalance(poolTokenA)).to.equal(beforeVault);
    expect(await tokenBalance(adminAtaA)).to.equal(beforeBorrower);
  });

  it("keeps flash loans atomic once settled and cannot retain funds afterwards", async () => {
    const beforeVault = await tokenBalance(poolTokenB);
    const beforeBorrower = await tokenBalance(adminAtaB);

    try {
      await program.methods
        .flashLoan(new anchor.BN(1_000_000), MOCK_CALLBACK_PROGRAM_ID)
        .accountsPartial({
          borrower: admin.publicKey,
          borrowerTokenAccount: adminAtaB,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts([
          {
            pubkey: MOCK_CALLBACK_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
        ])
        .signers([admin])
        .rpc();
      expect.fail("Post-transaction retention attempt should fail");
    } catch (error: any) {
      expect(getErrorCode(error)).to.equal("flashloannotrepaid");
    }

    expect(await tokenBalance(poolTokenB)).to.equal(beforeVault);
    expect(await tokenBalance(adminAtaB)).to.equal(beforeBorrower);
  });

  it("processes a tiny swap whose fee rounds down to zero without reverting", async () => {
    // amount_in = 333, fee = 333 * 30 / 10000 = 0 (integer division).
    await program.methods
      .swap(new anchor.BN(333), new anchor.BN(0))
      .accountsPartial({
        user: admin.publicKey,
        userTokenIn: adminAtaA,
        userTokenOut: adminAtaB,
        pool: poolPda,
        poolTokenA,
        poolTokenB,
        tokenIn: tokenA,
        tokenOut: tokenB,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        pythPriceA: PublicKey.default,
        pythPriceB: PublicKey.default,
      })
      .signers([admin])
      .rpc();
  });

  it("reverts a u64::MAX swap instead of producing corrupted output", async () => {
    try {
      await program.methods
        .swap(new anchor.BN("18446744073709551615"), new anchor.BN(0))
        .accountsPartial({
          user: admin.publicKey,
          userTokenIn: adminAtaA,
          userTokenOut: adminAtaB,
          pool: poolPda,
          poolTokenA,
          poolTokenB,
          tokenIn: tokenA,
          tokenOut: tokenB,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          pythPriceA: PublicKey.default,
          pythPriceB: PublicKey.default,
        })
        .signers([admin])
        .rpc();
      expect.fail("u64::MAX swap should revert");
    } catch (error: any) {
      const code = getErrorCode(error);
      expect(code === "excessiveswapamount" || code === "overflow").to.equal(
        true
      );
    }
  });
});
