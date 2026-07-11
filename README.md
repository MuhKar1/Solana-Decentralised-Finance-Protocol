# DeFi Protocol (Anchor/Solana)

## Executive Summary
This repository contains a Solana on-chain DeFi protocol implemented with Anchor. The codebase provides three major domains in one program:

- Governance and administrative controls with multisig approvals and timelock enforcement.
- Token staking for two token classes (SOL-like and USDC-like SPL mints) with reward accounting.
- Automated market maker (AMM) liquidity and swap functionality, including guarded flash loans.

The project has been refactored into a modular architecture to improve maintainability and auditability:

- Domain-specific instruction modules.
- Centralized state definitions.
- Centralized error definitions.
- A minimal program entrypoint that routes to instruction handlers.

Program ID (localnet config):

- `FDwF1iC4FYJrAMK9ns7pSUjZdhaZRjQ857bsaQEyZ7B1`

## Architecture
The on-chain program is organized under `programs/de-fi/src` as follows:

- `lib.rs`: Program entrypoint and instruction routing.
- `instructions/admin.rs`: State initialization, vault setup, multisig governance, timelocked updates.
- `instructions/staking.rs`: Stake, unstake, rewards claim/update, emergency unstake, stake-account close.
- `instructions/liquidity.rs`: Pool creation, liquidity add/remove, emergency remove, swaps, flash loan execution.
- `state/pool.rs`: Core account/state structs and protocol enums.
- `state/mod.rs`: Shared constants and reward accumulation helpers.
- `errors.rs`: Protocol-specific error codes.
- `events.rs`: Event emission types for major state-changing actions.

This layout decouples core concerns and simplifies code review paths for governance, staking, and AMM logic.

## Implemented Features
### Governance and Admin
- Program state initialization with authority and 3 governance signers.
- Separate initialization for SOL and USDC staking/reward/treasury token accounts.
- Reward vault funding by authority.
- Multisig proposal lifecycle:
  - `propose_action`
  - `approve_action`
  - `cancel_action`
- Controlled operations behind multisig and timelock:
  - `pause`
  - `unpause`
  - `update_reward_rate`
  - `update_flash_loan_callback_program`

### Staking and Rewards
- Stake/unstake for token type `0` (SOL-like mint) and `1` (USDC-like mint).
- Per-user stake account PDA by `(user, token_type)`.
- Reward-per-token model with global and per-user checkpoints.
- Reward claims from dedicated reward vaults.
- Manual reward update endpoint (`update_rewards`) for synchronization.
- Minimum stake threshold enforcement.
- Emergency unstake path available only when paused.
- Stake account closure gated by zero principal and zero pending rewards.

### AMM and Liquidity
- Deterministic pool PDA per ordered token pair.
- LP mint creation and tracked invariant (`k_last`).
- Add/remove liquidity with slippage constraints.
- Proportionality checks for non-initial liquidity provision.
- Emergency liquidity removal path available only when paused.
- Constant-product swap with fee deduction, slippage guard, and post-swap invariant enforcement.
- Swap-size protection (max 10% reserve-side input per swap).

### Flash Loans
- Flash loan from pool vaults with:
  - Callback-program allowlist model.
  - Maximum loan bound (50% of selected pool reserve).
  - Fee computation and repayment/invariant validation in the same transaction.
  - Explicit callback invocation using CPI to borrower program.

### Error Handling and Events
- Rich custom error surface in `errors.rs` for arithmetic safety, authorization, timelock, token validation, slippage, invariant, and flash loan constraints.
- Event emission for major actions (`PoolCreated`, `LiquidityAdded`, `SwapEvent`, `StakeEvent`, `UnstakeEvent`, etc.) to support observability and off-chain indexing.

## Security and Control Model
- Pausable protocol design.
- Emergency-only operations restricted to paused state.
- Multisig signer checks for governance actions.
- Timelock enforcement on sensitive state transitions.
- Defensive arithmetic with checked operations and custom overflow/underflow errors.
- Token-type validation and account constraints via Anchor account macros.
- Slippage and invariant guards for AMM operations.

## What Has Been Achieved
- End-to-end localnet functional workflow for state setup, staking lifecycle, governance flow, pool lifecycle, and key safety checks.
- Modularized codebase suitable for targeted auditing and incremental growth.
- Comprehensive integration-style TypeScript tests for happy paths and critical rejection paths.

## Known Limitations and Not Yet Achieved
The current codebase is functional for local development and demonstration, but the following items should be considered pending for production-grade deployment:

- No formal economic audit artifacts are included (fee model calibration, stress simulations, adversarial market analysis).
- No formal security audit reports are included.
- Test coverage is integration-focused; property/fuzz testing and exhaustive invariant testing are not included.
- Oracle-based pricing/risk controls are not implemented.
- Frontend and operator tooling are minimal in this repository.
- Mainnet deployment pipelines and governance operations playbooks are not included.

These items are typical next steps before production launch.

## Repository Structure
Top-level structure:

- `Anchor.toml`: Anchor workspace and localnet program mapping.
- `Cargo.toml`: Rust workspace configuration.
- `programs/de-fi`: On-chain program crate.
- `tests/de-fi.ts`: Integration and security-behavior tests (TypeScript + Mocha).
- `migrations/deploy.ts`: Anchor deployment hook scaffold.
- `app/`: Application-facing workspace folder (currently not central to on-chain tests).

## Prerequisites
Install the following toolchain components:

- Rust (stable toolchain).
- Solana CLI compatible with Anchor version in use.
- Anchor CLI.
- Node.js (LTS recommended) and Yarn.

Recommended checks:

- `rustc --version`
- `solana --version`
- `anchor --version`
- `node --version`
- `yarn --version`

## Installation
From repository root:

```bash
yarn install
```

## Build
Build the Anchor program:

```bash
anchor build
```

Optional Rust-only check for workspace:

```bash
cargo check
```

## Run Tests
Run full Anchor tests against local validator:

```bash
anchor test
```

The Anchor script configuration runs:

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts
```

## Test Coverage Overview
The test suite in `tests/de-fi.ts` validates both happy paths and selected adversarial paths.

Validated flows include:

- State initialization.
- SOL and USDC account initialization.
- Reward vault funding.
- SOL staking and unstaking.
- Reward claims after reward updates.
- AMM pool creation.
- Liquidity provision and LP mint checks.
- Token swap execution with output assertions.
- Governance cancel path to prevent stuck proposals.
- Multisig pause/unpause behavior with timelock enforcement.
- Timelocked reward-rate update and reward checkpoint behavior.
- Rejection of dust stake attempts below minimum threshold.
- Rejection of unauthorized multisig calls.
- Rejection of malformed swap account wiring (duplicate account abuse).
- Rejection of flash loan when callback program is not configured.

Coverage gaps that remain:

- Dedicated tests for successful flash-loan callback + repayment path.
- Extensive edge-case tests for extreme liquidity ratios and long-duration reward accrual.
- Property/fuzz testing of swap and liquidity invariants.

## Development Notes
- The protocol currently distinguishes two staking token classes by token type (`0` and `1`).
- Reward normalization accounts for decimal differences between SOL-like (9) and USDC-like (6) mints.
- Governance-sensitive operations are intentionally separated from user-path instructions.

## Operational Commands
Common local workflow:

1. `anchor build`
2. `anchor test`
3. `anchor deploy` (when intentionally deploying to configured cluster)

Anchor provider/cluster defaults are set in `Anchor.toml`.

## License
This project is distributed under the license declared in the repository (`LICENSE`).

## Disclaimer
This software is provided for development, testing, and research purposes. Deploying financial smart contracts to public networks without independent security and economic review introduces material risk.