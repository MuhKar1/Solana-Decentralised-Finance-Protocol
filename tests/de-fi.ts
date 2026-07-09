import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Defi } from "../target/types/defi";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

describe("de-fi functional tests", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const program = anchor.workspace.Defi as Program<Defi>;

  // Keypairs
  const admin = (provider.wallet as any).payer as anchor.web3.Keypair;
  const signer1 = anchor.web3.Keypair.generate();
  const signer2 = anchor.web3.Keypair.generate();
  const signer3 = anchor.web3.Keypair.generate();
  const user = anchor.web3.Keypair.generate();

  // Mints
  let solMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;

  // PDAs
  let statePda: anchor.web3.PublicKey;
  let stakingPoolSolPda: anchor.web3.PublicKey;
  let stakingPoolUsdcPda: anchor.web3.PublicKey;
  let rewardVaultSolPda: anchor.web3.PublicKey;
  let rewardVaultUsdcPda: anchor.web3.PublicKey;
  let protocolTreasurySolPda: anchor.web3.PublicKey;
  let protocolTreasuryUsdcPda: anchor.web3.PublicKey;

  let userStakeSolPda: anchor.web3.PublicKey;
  let userStakeUsdcPda: anchor.web3.PublicKey;

  // Token Accounts
  let adminSolAta: anchor.web3.PublicKey;
  let adminUsdcAta: anchor.web3.PublicKey;
  let userSolAta: anchor.web3.PublicKey;
  let userUsdcAta: anchor.web3.PublicKey;

  // AMM Keys (for pool)
  let tokenA: anchor.web3.PublicKey;
  let tokenB: anchor.web3.PublicKey;
  let poolPda: anchor.web3.PublicKey;
  let poolTokenAAccountPda: anchor.web3.PublicKey;
  let poolTokenBAccountPda: anchor.web3.PublicKey;
  let lpTokenMintPda: anchor.web3.PublicKey;
  let userLpAta: anchor.web3.PublicKey;

  async function transferSol(
    from: anchor.web3.Keypair,
    to: anchor.web3.PublicKey,
    amountLamports: number
  ) {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports: amountLamports,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [from]);
  }

  function extractErrorCode(error: any): string {
    const code =
      error?.error?.errorCode?.code ??
      error?.errorCode?.code ??
      error?.error?.code ??
      error?.code ??
      "";
    return String(code);
  }

  function extractErrorText(error: any): string {
    const message =
      error?.error?.errorMessage ??
      error?.error?.message ??
      error?.message ??
      String(error);
    return String(message);
  }

  function toU64LeBuffer(value: number): Buffer {
    return new anchor.BN(value).toArrayLike(Buffer, "le", 8);
  }

  async function waitMs(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function integerSqrt(value: bigint): bigint {
    if (value < 2n) {
      return value;
    }
    let x0 = value;
    let x1 = (x0 + value / x0) / 2n;
    while (x1 < x0) {
      x0 = x1;
      x1 = (x0 + value / x0) / 2n;
    }
    return x0;
  }

  before(async () => {
    try {
      console.log("Starting before hook...");
      console.log("Connection endpoint:", connection.rpcEndpoint);
      console.log("Admin public key:", admin?.publicKey?.toBase58());
      console.log("User public key:", user.publicKey.toBase58());

      // Fund signer1, signer2, signer3, user from admin
      const amountToFund = 5 * anchor.web3.LAMPORTS_PER_SOL;
      console.log("Funding signer1...");
      await transferSol(admin, signer1.publicKey, amountToFund);
      console.log("Funding signer2...");
      await transferSol(admin, signer2.publicKey, amountToFund);
      console.log("Funding signer3...");
      await transferSol(admin, signer3.publicKey, amountToFund);
      console.log("Funding user...");
      await transferSol(admin, user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);

      console.log("Creating solMint...");
      // Create Mints
      solMint = await createMint(
        connection,
        admin,
        admin.publicKey,
        null,
        9
      );
      console.log("solMint created:", solMint.toBase58());

      console.log("Creating usdcMint...");
      usdcMint = await createMint(
        connection,
        admin,
        admin.publicKey,
        null,
        6
      );
      console.log("usdcMint created:", usdcMint.toBase58());

      // Calculate PDAs
      statePda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("state")],
        program.programId
      )[0];

      stakingPoolSolPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("staking_pool_sol")],
        program.programId
      )[0];

      stakingPoolUsdcPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("staking_pool_usdc")],
        program.programId
      )[0];

      rewardVaultSolPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("reward_vault_sol")],
        program.programId
      )[0];

      rewardVaultUsdcPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("reward_vault_usdc")],
        program.programId
      )[0];

      protocolTreasurySolPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_treasury"), solMint.toBuffer()],
        program.programId
      )[0];

      protocolTreasuryUsdcPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_treasury"), usdcMint.toBuffer()],
        program.programId
      )[0];

      userStakeSolPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_stake"), user.publicKey.toBuffer(), Buffer.from([0])],
        program.programId
      )[0];

      userStakeUsdcPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_stake"), user.publicKey.toBuffer(), Buffer.from([1])],
        program.programId
      )[0];

      console.log("Creating userSolAta...");
      // Create User ATAs
      userSolAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          solMint,
          user.publicKey
        )
      ).address;
      console.log("userSolAta created:", userSolAta.toBase58());

      console.log("Creating userUsdcAta...");
      userUsdcAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          usdcMint,
          user.publicKey
        )
      ).address;
      console.log("userUsdcAta created:", userUsdcAta.toBase58());

      console.log("Creating adminSolAta...");
      // Create Admin ATAs (for funding reward vaults)
      adminSolAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          solMint,
          admin.publicKey
        )
      ).address;
      console.log("adminSolAta created:", adminSolAta.toBase58());

      console.log("Creating adminUsdcAta...");
      adminUsdcAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          usdcMint,
          admin.publicKey
        )
      ).address;
      console.log("adminUsdcAta created:", adminUsdcAta.toBase58());

      console.log("--- Protocol Address Map ---");
      console.log("statePda:", statePda.toBase58());
      console.log("stakingPoolSolPda:", stakingPoolSolPda.toBase58());
      console.log("stakingPoolUsdcPda:", stakingPoolUsdcPda.toBase58());
      console.log("rewardVaultSolPda:", rewardVaultSolPda.toBase58());
      console.log("rewardVaultUsdcPda:", rewardVaultUsdcPda.toBase58());
      console.log("protocolTreasurySolPda:", protocolTreasurySolPda.toBase58());
      console.log("protocolTreasuryUsdcPda:", protocolTreasuryUsdcPda.toBase58());
    } catch (e) {
      console.error("CRITICAL ERROR IN BEFORE HOOK:", e);
      throw e;
    }

    // Setup AMM sorted token mints
    if (Buffer.compare(solMint.toBuffer(), usdcMint.toBuffer()) < 0) {
      tokenA = solMint;
      tokenB = usdcMint;
    } else {
      tokenA = usdcMint;
      tokenB = solMint;
    }

    poolPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenA.toBuffer(), tokenB.toBuffer()],
      program.programId
    )[0];

    poolTokenAAccountPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool_token_a"), poolPda.toBuffer()],
      program.programId
    )[0];

    poolTokenBAccountPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool_token_b"), poolPda.toBuffer()],
      program.programId
    )[0];

    lpTokenMintPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_token_mint"), poolPda.toBuffer()],
      program.programId
    )[0];

    userLpAta = getAssociatedTokenAddressSync(
      lpTokenMintPda,
      user.publicKey
    );
  });

  it("Initializes state correctly", async () => {
    console.log("--- Initializing core program state ---");
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
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.programState.fetch(statePda);
    console.log("State authority:", state.authority.toBase58());
    console.log("State paused:", state.paused);
    console.log("State min stake amount:", state.minStakeAmount.toString());
    console.log("State timelock delay:", state.timelockDelay.toString());
    expect(state.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(state.signer1.toBase58()).to.equal(signer1.publicKey.toBase58());
    expect(state.signer2.toBase58()).to.equal(signer2.publicKey.toBase58());
    expect(state.signer3.toBase58()).to.equal(signer3.publicKey.toBase58());
    expect(state.paused).to.be.false;
  });

  it("Initializes SOL-related accounts", async () => {
    await program.methods
      .initializeSolAccounts()
      .accountsPartial({
        state: statePda,
        stakingPoolSol: stakingPoolSolPda,
        rewardVaultSol: rewardVaultSolPda,
        protocolTreasurySol: protocolTreasurySolPda,
        solMint: solMint,
        authority: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.programState.fetch(statePda);
    expect(state.stakingPoolSolBump).to.be.greaterThan(0);
    expect(state.rewardVaultSolBump).to.be.greaterThan(0);
  });

  it("Initializes USDC-related accounts", async () => {
    await program.methods
      .initializeUsdcAccounts()
      .accountsPartial({
        state: statePda,
        stakingPoolUsdc: stakingPoolUsdcPda,
        rewardVaultUsdc: rewardVaultUsdcPda,
        protocolTreasuryUsdc: protocolTreasuryUsdcPda,
        usdcMint: usdcMint,
        authority: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.programState.fetch(statePda);
    expect(state.stakingPoolUsdcBump).to.be.greaterThan(0);
    expect(state.rewardVaultUsdcBump).to.be.greaterThan(0);
  });

  it("Funds the reward vaults", async () => {
    const fundAmount = new anchor.BN(100_000_000_000); // 100 tokens

    // Mint SOL-tokens to admin and fund SOL reward vault
    await mintTo(connection, admin, solMint, adminSolAta, admin.publicKey, fundAmount.toNumber());
    await program.methods
      .fundRewardVault(fundAmount, 0)
      .accountsPartial({
        authority: admin.publicKey,
        authorityTokenAccount: adminSolAta,
        rewardVault: rewardVaultSolPda,
        stakeMint: solMint,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // Mint USDC-tokens to admin and fund USDC reward vault
    await mintTo(connection, admin, usdcMint, adminUsdcAta, admin.publicKey, 100_000_000); // 100 USDC (6 decimals)
    await program.methods
      .fundRewardVault(new anchor.BN(100_000_000), 1)
      .accountsPartial({
        authority: admin.publicKey,
        authorityTokenAccount: adminUsdcAta,
        rewardVault: rewardVaultUsdcPda,
        stakeMint: usdcMint,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const solVault = await connection.getTokenAccountBalance(rewardVaultSolPda);
    const usdcVault = await connection.getTokenAccountBalance(rewardVaultUsdcPda);
    expect(solVault.value.amount).to.equal("100000000000");
    expect(usdcVault.value.amount).to.equal("100000000");
  });

  it("Stakes SOL tokens successfully", async () => {
    console.log("--- Happy-path stake flow ---");
    const stakeAmount = new anchor.BN(2_000_000_000); // 2 SOL (above min stake of 1 SOL)

    // Mint SOL to user
    await mintTo(connection, admin, solMint, userSolAta, admin.publicKey, stakeAmount.toNumber());

    await program.methods
      .stake(stakeAmount, 0)
      .accountsPartial({
        user: user.publicKey,
        userTokenAccount: userSolAta,
        stakingPool: stakingPoolSolPda,
        state: statePda,
        userStake: userStakeSolPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userStakeState = await program.account.userStake.fetch(userStakeSolPda);
    console.log("User stake after deposit:", userStakeState.stakedAmount.toString());
    expect(userStakeState.stakedAmount.toString()).to.equal("2000000000");
    expect(userStakeState.tokenType).to.equal(0);
  });

  it("Unstakes SOL tokens successfully", async () => {
    const unstakeAmount = new anchor.BN(1_000_000_000); // 1 SOL

    await program.methods
      .unstake(unstakeAmount, 0)
      .accountsPartial({
        user: user.publicKey,
        userTokenAccount: userSolAta,
        stakingPool: stakingPoolSolPda,
        state: statePda,
        userStake: userStakeSolPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userStakeState = await program.account.userStake.fetch(userStakeSolPda);
    expect(userStakeState.stakedAmount.toString()).to.equal("1000000000");
  });

  it("Claims staking rewards successfully", async () => {
    const rewardTokenAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        solMint,
        user.publicKey
      )
    ).address;

    // Trigger update rewards manually to accumulate rewards
    await program.methods
      .updateRewards(0)
      .accountsPartial({
        user: user.publicKey,
        state: statePda,
        userStake: userStakeSolPda,
      })
      .signers([user])
      .rpc();

    await program.methods
      .claimRewards(0)
      .accountsPartial({
        user: user.publicKey,
        userRewardTokenAccount: rewardTokenAta,
        rewardVaultSol: rewardVaultSolPda,
        rewardVaultUsdc: rewardVaultUsdcPda,
        state: statePda,
        userStake: userStakeSolPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userStakeState = await program.account.userStake.fetch(userStakeSolPda);
    expect(userStakeState.pendingRewards.toNumber()).to.equal(0);
  });

  it("Creates a liquidity pool for AMM", async () => {
    await program.methods
      .createPool(30) // 0.3% pool fee
      .accountsPartial({
        pool: poolPda,
        tokenAMint: tokenA,
        tokenBMint: tokenB,
        tokenAAccount: poolTokenAAccountPda,
        tokenBAccount: poolTokenBAccountPda,
        lpTokenMint: lpTokenMintPda,
        state: statePda,
        authority: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const poolState = await program.account.pool.fetch(poolPda);
    expect(poolState.feeBasisPoints).to.equal(30);
    expect(poolState.tokenAMint.toBase58()).to.equal(tokenA.toBase58());
    expect(poolState.tokenBMint.toBase58()).to.equal(tokenB.toBase58());
  });

  it("Adds liquidity to the AMM pool", async () => {
    const amountA = new anchor.BN(10_000_000_000); // 10 units token A
    const amountB = new anchor.BN(10_000_000_000); // 10 units token B
    const minLp = new anchor.BN(100_000);

    let userAtaA: anchor.web3.PublicKey;
    let userAtaB: anchor.web3.PublicKey;

    if (tokenA.toBase58() === solMint.toBase58()) {
      userAtaA = userSolAta;
      userAtaB = userUsdcAta;
    } else {
      userAtaA = userUsdcAta;
      userAtaB = userSolAta;
    }

    // Mint enough pool tokens to user
    await mintTo(connection, admin, tokenA, userAtaA, admin.publicKey, amountA.toNumber());
    await mintTo(connection, admin, tokenB, userAtaB, admin.publicKey, amountB.toNumber());

    // Create the associated token account for the LP token now that the LP token mint exists
    await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      lpTokenMintPda,
      user.publicKey
    );

    await program.methods
      .addLiquidity(amountA, amountB, minLp)
      .accountsPartial({
        user: user.publicKey,
        userTokenA: userAtaA,
        userTokenB: userAtaB,
        userLpTokenAccount: userLpAta,
        pool: poolPda,
        poolTokenA: poolTokenAAccountPda,
        poolTokenB: poolTokenBAccountPda,
        lpTokenMint: lpTokenMintPda,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    const userLpBal = await connection.getTokenAccountBalance(userLpAta);
    const sqrtProduct = integerSqrt(BigInt(amountA.toString()) * BigInt(amountB.toString()));
    const expectedLp = sqrtProduct - 1000n;
    expect(userLpBal.value.amount).to.equal(expectedLp.toString());
  });

  it("Swaps token A for token B successfully", async () => {
    console.log("--- Happy-path swap execution ---");
    let userAtaA: anchor.web3.PublicKey;
    let userAtaB: anchor.web3.PublicKey;

    if (tokenA.toBase58() === solMint.toBase58()) {
      userAtaA = userSolAta;
      userAtaB = userUsdcAta;
    } else {
      userAtaA = userUsdcAta;
      userAtaB = userSolAta;
    }

    // Amount to swap is less than 10% of pool reserves (which is 10,000,000,000 / 10 = 1,000,000,000)
    const amountIn = new anchor.BN(200_000_000); 
    const minAmountOut = new anchor.BN(100_000_000);

    await mintTo(connection, admin, tokenA, userAtaA, admin.publicKey, amountIn.toNumber());

    const userUsdcBalBefore = await connection.getTokenAccountBalance(userAtaB);

    await program.methods
      .swap(amountIn, minAmountOut)
      .accountsPartial({
        user: user.publicKey,
        userTokenIn: userAtaA,
        userTokenOut: userAtaB,
        pool: poolPda,
        poolTokenA: poolTokenAAccountPda,
        poolTokenB: poolTokenBAccountPda,
        tokenIn: tokenA,
        tokenOut: tokenB,
        state: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userUsdcBalAfter = await connection.getTokenAccountBalance(userAtaB);
    expect(parseFloat(userUsdcBalAfter.value.amount)).to.be.greaterThan(
      parseFloat(userUsdcBalBefore.value.amount)
    );
  });

  it("Prevents governance bricking by canceling a pending action", async () => {
    console.log("--- Governance Gridlock Test ---");
    console.log("Proposing pause action using signer1...");

    await program.methods
      .proposeAction({ pause: {} }, Buffer.alloc(0))
      .accountsPartial({
        state: statePda,
        admin: signer1.publicKey,
      })
      .signers([signer1])
      .rpc();

    const stateAfterProposal = await program.account.programState.fetch(statePda);
    expect(stateAfterProposal.pendingAction).to.not.be.null;
    console.log("Pending action set:", stateAfterProposal.pendingAction !== null);

    console.log("Canceling pending action using signer2...");
    await program.methods
      .cancelAction()
      .accountsPartial({
        state: statePda,
        admin: signer2.publicKey,
      })
      .signers([signer2])
      .rpc();

    const stateAfterCancel = await program.account.programState.fetch(statePda);
    expect(stateAfterCancel.pendingAction).to.be.null;
    console.log("Pending action cleared:", stateAfterCancel.pendingAction === null);
  });

  it("Executes multisig pause and unpause with timelock enforcement", async () => {
    console.log("--- Multisig Execution + Timelock Test ---");

    await program.methods
      .proposeAction({ pause: {} }, Buffer.alloc(0))
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

    await program.methods
      .pause()
      .accountsPartial({ state: statePda, admin: signer1.publicKey })
      .signers([signer1])
      .rpc();

    let pausedState = await program.account.programState.fetch(statePda);
    expect(pausedState.paused).to.equal(true);
    console.log("Paused state after multisig execution:", pausedState.paused);

    await mintTo(connection, admin, solMint, userSolAta, admin.publicKey, 1_000_000_000);
    try {
      await program.methods
        .stake(new anchor.BN(1_000_000_000), 0)
        .accountsPartial({
          user: user.publicKey,
          userTokenAccount: userSolAta,
          stakingPool: stakingPoolSolPda,
          state: statePda,
          userStake: userStakeSolPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Stake should fail while protocol is paused");
    } catch (error: any) {
      expect(extractErrorCode(error).toLowerCase()).to.equal("paused");
    }

    await program.methods
      .proposeAction({ unpause: {} }, Buffer.alloc(0))
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

    try {
      await program.methods
        .unpause()
        .accountsPartial({ state: statePda, admin: signer1.publicKey })
        .signers([signer1])
        .rpc();
      expect.fail("Unpause should fail before timelock expires");
    } catch (error: any) {
      const code = extractErrorCode(error).toLowerCase();
      expect(code).to.equal("timelocknotexpired");
      console.log("Timelock blocked early unpause as expected.");
    }

    await waitMs(2200);

    await program.methods
      .unpause()
      .accountsPartial({ state: statePda, admin: signer1.publicKey })
      .signers([signer1])
      .rpc();

    pausedState = await program.account.programState.fetch(statePda);
    expect(pausedState.paused).to.equal(false);
    console.log("Unpaused state after timelock:", pausedState.paused);
  });

  it("Applies reward-rate changes only after timelock and checkpoints with old rate", async () => {
    console.log("--- Reward Rate Timelock + Checkpoint Test ---");

    await program.methods
      .updateRewards(0)
      .accountsPartial({ user: user.publicKey, state: statePda, userStake: userStakeSolPda })
      .signers([user])
      .rpc();

    const stateBefore = await program.account.programState.fetch(statePda);
    const newRate = 1000;
    const updateRateData = toU64LeBuffer(newRate);

    await waitMs(1200);

    await program.methods
      .proposeAction({ updateRewardRate: {} }, updateRateData)
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

    try {
      await program.methods
        .updateRewardRate()
        .accountsPartial({ state: statePda, admin: signer1.publicKey })
        .signers([signer1])
        .rpc();
      expect.fail("Update reward rate should fail before timelock expires");
    } catch (error: any) {
      expect(extractErrorCode(error).toLowerCase()).to.equal("timelocknotexpired");
    }

    await waitMs(2200);

    await program.methods
      .updateRewardRate()
      .accountsPartial({ state: statePda, admin: signer1.publicKey })
      .signers([signer1])
      .rpc();

    const stateAfter = await program.account.programState.fetch(statePda);
    expect(stateAfter.rewardRate.toNumber()).to.equal(newRate);
    expect(stateAfter.pendingAction).to.be.null;

    const beforeRps = BigInt(stateBefore.rewardPerTokenStored.toString());
    const afterRps = BigInt(stateAfter.rewardPerTokenStored.toString());
    const deltaRps = afterRps - beforeRps;

    const beforeTs = BigInt(stateBefore.lastUpdateTime.toString());
    const afterTs = BigInt(stateAfter.lastUpdateTime.toString());
    const elapsed = afterTs - beforeTs;

    const oldRate = BigInt(stateBefore.rewardRate.toString());
    const precision = BigInt(stateBefore.precision.toString());
    const totalStaked =
      BigInt(stateBefore.totalStakedSol.toString()) +
      BigInt(stateBefore.totalStakedUsdc.toString()) * 1000n;

    const expectedOldRateDelta = (elapsed * oldRate * precision) / totalStaked;
    const expectedNewRateDelta = (elapsed * BigInt(newRate) * precision) / totalStaked;

    expect(deltaRps > 0n).to.equal(true);
    expect(deltaRps <= expectedOldRateDelta + 10n).to.equal(true);
    expect(deltaRps < expectedNewRateDelta).to.equal(true);
    console.log("Reward accumulator delta:", deltaRps.toString());
  });

  it("Rejects stakes below minimum threshold", async () => {
    console.log("--- Dust/Griefing Test ---");
    const dustAmount = new anchor.BN(100); // below min stake (1_000_000_000)

    try {
      await program.methods
        .stake(dustAmount, 0)
        .accountsPartial({
          user: user.publicKey,
          userTokenAccount: userSolAta,
          stakingPool: stakingPoolSolPda,
          state: statePda,
          userStake: userStakeSolPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Dust stake should fail with InsufficientAmount");
    } catch (error: any) {
      const code = extractErrorCode(error).toLowerCase();
      console.log("Dust stake rejected with code:", code || "<none>");
      expect(code).to.equal("insufficientamount");
    }
  });

  it("Rejects multisig actions from unauthorized signers", async () => {
    console.log("--- Unauthorized Multisig Access Test ---");
    const unauthorizedSigner = anchor.web3.Keypair.generate();
    await transferSol(admin, unauthorizedSigner.publicKey, 0.5 * anchor.web3.LAMPORTS_PER_SOL);

    try {
      await program.methods
        .pause()
        .accountsPartial({
          state: statePda,
          admin: unauthorizedSigner.publicKey,
        })
        .signers([unauthorizedSigner])
        .rpc();
      expect.fail("Unauthorized multisig signer should be rejected");
    } catch (error: any) {
      const code = extractErrorCode(error).toLowerCase();
      console.log("Unauthorized signer rejected with code:", code || "<none>");
      expect(code).to.equal("unauthorized");
    }
  });

  it("Rejects malicious attempts to pass the same account twice in swap", async () => {
    console.log("--- Double-Account Corruption Test ---");

    let userAtaA: anchor.web3.PublicKey;
    if (tokenA.toBase58() === solMint.toBase58()) {
      userAtaA = userSolAta;
    } else {
      userAtaA = userUsdcAta;
    }

    const amountIn = new anchor.BN(100_000_000);
    const minAmountOut = new anchor.BN(1);

    await mintTo(connection, admin, tokenA, userAtaA, admin.publicKey, amountIn.toNumber());

    try {
      await program.methods
        .swap(amountIn, minAmountOut)
        .accountsPartial({
          user: user.publicKey,
          userTokenIn: userAtaA,
          userTokenOut: userAtaA,
          pool: poolPda,
          poolTokenA: poolTokenAAccountPda,
          poolTokenB: poolTokenBAccountPda,
          tokenIn: tokenA,
          tokenOut: tokenB,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      expect.fail("Swap should reject duplicate input/output token accounts");
    } catch (error: any) {
      const code = extractErrorCode(error).toLowerCase();
      const text = extractErrorText(error).toLowerCase();
      console.log("Duplicate-account rejection code:", code || "<none>");
      console.log("Duplicate-account rejection message:", text);

      const matchedKnownCause =
        code === "constraintraw" ||
        code === "constrainttokenmint" ||
        code === "invalidmintorder" ||
        text.includes("constraint") ||
        text.includes("mint");

      expect(matchedKnownCause).to.equal(true);
    }
  });

  it("Rejects flash loans when callback program is not configured", async () => {
    console.log("--- Flash Loan Guard Test ---");

    try {
      await program.methods
        .flashLoan(new anchor.BN(1000), program.programId)
        .accountsPartial({
          borrower: user.publicKey,
          borrowerTokenAccount: userSolAta,
          pool: poolPda,
          poolTokenA: poolTokenAAccountPda,
          poolTokenB: poolTokenBAccountPda,
          state: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        })
        .signers([user])
        .rpc();
      expect.fail("Flash loan should fail when callback program is unset");
    } catch (error: any) {
      const code = extractErrorCode(error).toLowerCase();
      console.log("Flash loan guard rejection code:", code || "<none>");
      expect(code).to.equal("invalidcallbackprogram");
    }
  });
});
