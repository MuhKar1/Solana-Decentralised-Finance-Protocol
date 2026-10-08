# Security Review

## Status

This repository is a production-oriented DeFi protocol prototype. It is suitable
for portfolio review, technical interviews, and local/devnet experimentation. It
is not ready to secure real user funds without an independent audit, full
integration test coverage, deployment hardening, and operational monitoring.

## Scope

Reviewed surfaces:

- Anchor program account constraints and PDA model.
- Multi-signature governance and timelock execution paths.
- Staking reward accumulator and user reward checkpointing.
- AMM liquidity mint/burn, swap, and invariant checks.
- Flash-loan callback allowlist and post-callback repayment validation.
- Pyth oracle integration for swap price-deviation checks.
- Frontend account derivation and transaction construction.

## Current Protections

- Protocol vaults are PDAs with no private keys.
- Sensitive operations require configured multisig signers.
- Governance execution is timelocked.
- Emergency staking and liquidity withdrawals are available when paused.
- Arithmetic uses checked operations in contract-critical paths.
- AMM pool mint ordering is canonicalized by public key.
- First LP deposit permanently locks minimum liquidity.
- Swaps enforce slippage, max trade size, and invariant preservation.
- Flash loans are callback-program allowlisted and atomically repayment-checked.
- Oracle-enabled swaps reject stale feeds and large AMM/oracle deviation.

## Known Limitations

- No independent audit has been performed.
- No formal verification or property-based invariant suite is included yet.
- TypeScript integration tests require generated Anchor artifacts in `target`.
- Frontend uses a copied IDL; deployments must keep it synchronized with the
  program build output.
- Governance signer rotation is intentionally unsupported. Lost signer keys
  require redeployment or a future migration design.
- Pyth parsing still uses a deprecated helper from `pyth-sdk-solana`; it should
  be migrated to the current SDK API before a real deployment.
- The demo frontend creates and mints a local/devnet USDC-like mint for testing.
  This must be replaced with an explicit, environment-specific token policy.
- The app defaults to public devnet RPC. Production deployment needs managed RPC,
  rate-limit handling, retry policy, and observability.
- Upgrade authority custody, release signing, incident response, and monitoring
  are not yet specified.

## Pre-Mainnet Checklist

- Run full Anchor integration tests on a clean checkout.
- Add property tests for AMM invariant preservation under randomized liquidity
  and swap sequences.
- Add reward accounting tests across many users, token mixes, idle periods, and
  reward-vault exhaustion.
- Add adversarial flash-loan callback tests for wrong accounts, wrong mints,
  underpayment, callback failure, and malicious remaining accounts.
- Add oracle tests for stale feeds, invalid feeds, negative prices, exponent
  differences, and deviation thresholds.
- Align Anchor versions across program, tests, and frontend.
- Generate frontend IDL from the build in CI.
- Define deployment environments, token addresses, oracle feeds, RPC providers,
  upgrade authority custody, and signer custody.
- Complete an external security audit and publish the report.

## Interview Notes

The project is best presented as a serious, security-conscious DeFi prototype:
it demonstrates protocol design, frontend integration, and risk awareness. Be
explicit that the project has production-style controls but has not crossed the
audit and operations bar required for real funds.
