const anchor = require("@coral-xyz/anchor");
const splToken = require("@solana/spl-token");

async function main() {
  const provider = anchor.AnchorProvider.env();
  const connection = provider.connection;
  const admin = provider.wallet.payer;
  const user = anchor.web3.Keypair.generate();

  console.log("Admin key:", admin.publicKey.toBase58());
  console.log("User key:", user.publicKey.toBase58());

  try {
    console.log("Creating solMint...");
    const solMint = await splToken.createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      9
    );
    console.log("solMint created:", solMint.toBase58());

    console.log("Creating user ATA for solMint...");
    const userSolAta = await splToken.getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      solMint,
      user.publicKey
    );
    console.log("userSolAta created:", userSolAta.address.toBase58());
  } catch (err) {
    console.error("Caught error in main:", err.stack || err);
  }
}

main();
