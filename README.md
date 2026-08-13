# Solana Decentralised Finance Protocol

[![Solana](https://img.shields.io/badge/Solana-Devnet-blue?logo=solana)](https://solana.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.30+-orange?logo=anchor)](https://www.anchor-lang.com/)
[![Next.js](https://img.shields.io/badge/Next.js-15+-black?logo=next.js)](https://nextjs.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

A **production-oriented** fullstack decentralised finance protocol on Solana featuring **multi-signature governance**, **dual-token yield staking** (SOL & USDC), an **automated market maker** with flash loan support, and **emergency pause mechanisms** — all accessible through a modern React/Next.js frontend.

Program ID (Devnet): `FDwF1iC4FYJrAMK9ns7pSUjZdhaZRjQ857bsaQEyZ7B1`

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Feature Breakdown](#feature-breakdown)
   - [Governance & Access Control](#1-governance--access-control)
   - [Staking & Rewards](#2-staking--rewards)
   - [AMM & Liquidity Pool](#3-amm--liquidity-pool)
   - [Flash Loans](#4-flash-loans)
   - [Emergency Mechanisms](#5-emergency-mechanisms)
4. [Security Model](#security-model)
5. [Frontend Application](#frontend-application)
6. [Project Structure](#project-structure)
7. [Getting Started](#getting-started)
8. [Testing](#testing)
9. [Deployment](#deployment)
10. [License & Disclaimer](#license--disclaimer)

---

## Overview

The DeFi Protocol is a complete on-chain financial application built on Solana using the Anchor framework. It combines three core DeFi primitives — governance, staking, and an AMM — into a single, auditable program with a polished React frontend.

**Key design principles:**

- **Separation of concerns** — Instruction modules are decoupled by domain (admin, staking, liquidity)
- **Defence in depth** — Multiple layers of security: multisig, timelocks, pause controls, arithmetic guards
- **User safety** — Emergency withdrawal paths, slippage protection, invariant enforcement
- **Fullstack transparency** — All 23 on-chain functions exposed through a self-documenting UI with real-time state display (30 custom error codes)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Frontend (Next.js 15)                  │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐  │
│  │ Staking  │ │   Swap   │ │  Pool   │ │  Liquidity   │  │
│  │ (SOL/    │ │ (SOL→    │ │ (Info + │ │ (Add/Remove/ │  │
│  │  USDC)   │ │  USDC)   │ │  Flash) │ │  Emergency)  │  │
│  └─────────┘ └──────────┘ └────────┘ └──────────────┘  │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Admin Panel (Toggle)                 │   │
│  │  Init State → SOL/USDC Accounts → Fund Vaults    │   │
│  │  → Create Pool → Governance (Multi-Sig)           │   │
│  │  → Live Protocol State Dashboard                  │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │       My Portfolio (Real-time On-Chain)           │   │
│  └──────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│                   Program (Anchor/Rust)                  │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐   │
│  │  admin.rs     │ │  staking.rs  │ │ liquidity.rs  │   │
│  │  Governance   │ │  Stake/      │ │ Pool/Swap/    │   │
│  │  Init/Vaults  │ │  Unstake/    │ │ Liquidity/    │   │
│  │  Multi-sig    │ │  Claim       │ │ Flash Loan    │   │
│  └──────────────┘ └──────────────┘ └───────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  state/pool.rs — ProgramState, Pool, UserStake   │   │
│  │  state/mod.rs  — Rewards math, constants         │   │
│  │  errors.rs     — 30 custom error codes           │   │
│  │  events.rs     — Event emission for indexing     │   │
│  └──────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│               Solana Devnet / Localnet                   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User connects wallet** → `@solana/wallet-adapter-react` provides signer
2. **Frontend reads on-chain state** → Direct RPC calls to Solana, deserializing Anchor account data
3. **Transactions** → Built client-side, auto-wrapping SOL to WSOL, auto-creating ATAs, then signed by wallet adapter
4. **Program executes** → Validates constraints, updates accounts, emits events
5. **UI refreshes** → Re-reads account data immediately after confirmation

### Account Model

All protocol accounts use **Program Derived Addresses (PDAs)** with deterministic seeds:

| Account | Seeds |
|---|---|
| Program State | `["state"]` |
| Staking Pool | `["staking_pool_sol"]` / `["staking_pool_usdc"]` |
| Reward Vault | `["reward_vault_sol"]` / `["reward_vault_usdc"]` |
| Protocol Treasury | `["protocol_treasury", mint]` |
| User Stake | `["user_stake", user_pubkey, [token_type]]` |
| Pool | `["pool", token_a_mint, token_b_mint]` |
| Pool Token Vault | `["pool_token_a", pool]` / `["pool_token_b", pool]` |
| LP Token Mint | `["lp_token_mint", pool]` |

---

## Feature Breakdown

### 1. Governance & Access Control

The protocol uses a **3-of-3 multi-signature scheme** with timelock enforcement for all sensitive operations.

| Operation | Requires | Timelock |
|---|---|---|
| Pause protocol | 3/3 signers, proposal + approvals | Yes |
| Unpause protocol | 3/3 signers, proposal + approvals | Yes |
| Update reward rate | 3/3 signers, proposal + approvals | Yes |
| Update flash loan callback | 3/3 signers, proposal + approvals | Yes |

**Proposal lifecycle:**
1. **Propose** — Any of the 3 signers initiates a proposal with encoded action data. The proposal's creation timestamp (`proposed_at`) is recorded here.
2. **Approve** — The remaining signers approve; each approval is tracked in a `[bool; 3]` bitmap.
3. **Execute** — The action executes only when **both** conditions hold: (a) all 3 signers have approved, **and** (b) `now >= proposed_at + timelock_delay`. The timelock countdown starts at **proposal creation time**, not at the final approval. If the signers take longer than the delay to reach 3/3, the action becomes executable immediately upon the final approval; otherwise there is a residual wait until the delay elapses.
4. **Cancel** — Any signer can cancel a pending proposal before execution.

**Admin-only initialisation:**
- `initialize_state` — Sets authority, 3 signer pubkeys, timelock delay, reward rate, protocol fee
- `initialize_sol_accounts` — Creates SOL staking pool, reward vault, and treasury PDAs
- `initialize_usdc_accounts` — Creates USDC staking pool, reward vault, and treasury PDAs
- `fund_reward_vault` — Deposits SOL/USDC into reward vaults (authority-gated)

### 2. Staking & Rewards

Dual-token staking with independent SOL and USDC pools. Each operates identically but with appropriate decimal handling (9 for SOL, 6 for USDC).

**Reward calculation model:**
- **Reward-per-token** global accumulator updated on each state change
- Per-user **reward_per_token_paid** checkpoint prevents double-claiming
- Time-capped accrual (max 24h per update) prevents exploitation
- Rewards distributed proportionally based on normalised stake amounts

**User operations:**
| Function | Description | Constraints |
|---|---|---|
| `stake` | Deposit tokens, earn rewards | Minimum 1 SOL or 1,000 USDC |
| `unstake` | Withdraw staked tokens | Pending rewards update automatically |
| `claim_rewards` | Claim accrued rewards | Token-type specific reward vault |
| `emergency_unstake` | Withdraw all when paused | Protocol must be paused |
| `close_stake_account` | Close empty stake PDA | Zero staked amount + zero pending rewards |
| `update_rewards` | Manual reward recalculation | For UI synchronisation |

**Token-type normalisation:**
```rust
MIN_STAKE_AMOUNT = 1_000_000_000  // 1 SOL (9 decimals) or 1,000 USDC (6 decimals)
```

Both tokens share the same economic equivalence (`1e9` raw units == 1 SOL == 1,000 USDC),
so SOL and USDC stake amounts are already comparable in their raw "base unit" and are
summed directly for reward accounting. USDC rewards are issued in USDC's native 6-decimal
precision on claim — no decimal rescaling is applied in the accumulator.

### 3. AMM & Liquidity Pool

A constant-product market maker (x·y = k) between SOL and USDC.

**Pool operations:**

| Function | Description | Safety |
|---|---|---|
| `create_pool` | Admin creates pool PDA + vault accounts | Authority-gated, fee 1–1000 bps |
| `add_liquidity` | Deposit SOL+USDC, receive LP tokens | Proportionality check, slippage guard |
| `remove_liquidity` | Burn LP tokens, withdraw SOL+USDC | Slippage guard, invariant update |
| `emergency_remove_liquidity` | Remove all LP when paused | Paused state only |
| `swap` | SOL → USDC exchange | Fee deduction, slippage guard, invariant enforcement |

**Key AMM rules:**
- Token pair ordering enforced (`token_a < token_b`) for deterministic PDA derivation
- Initial liquidity provision mints `sqrt(x·y)` LP tokens total: `MINIMUM_LIQUIDITY` (1,000) are
  minted to a PDA-owned lock account that can never be withdrawn, and `sqrt(x·y) - MINIMUM_LIQUIDITY`
  are minted to the provider
- Subsequent additions must maintain the pool ratio (proportionality tolerance ±0.1%)
- Swap size capped at 10% of reserve side to prevent extreme slippage
- Post-swap invariant must be ≥ pre-swap k_last value

**Fees:**
- **Swap fee:** Configurable at pool creation (default 30 bps = 0.3%)
- **Flash loan fee:** Fixed at 30 bps (0.3%) — hardcoded in contract
- Fees accrue to the pool, benefiting all LPs proportionally

### 4. Flash Loans

Permissioned flash loans with a callback-program allowlist model.

**Flow:**
1. Borrower's authorised callback program must be approved via governance
2. Borrower calls `flash_loan(amount, callback_program_id)`
3. Protocol transfers tokens from pool vault → borrower's token account
4. Protocol CPIs into `callback_program_id` with encoded loan data (amount, fee, deadline, vault)
5. Callback program performs arbitrage/liquidation logic and returns tokens to the vault
6. Protocol validates repayment: post-loan invariant ≥ pre-loan invariant + fee

**Safety bounds:**
- Maximum loan: 50% of the selected pool reserve
- Callback deadline: 60 seconds from initiation
- Only governor-approved programs may serve as callbacks
- Invariant enforcement ensures fee repayment

### 5. Emergency Mechanisms

Both `pause` and `unpause` require 3-of-3 signer approval **and** the timelock
delay to elapse (measured from the proposal's `proposed_at` timestamp).

| Mechanism | Trigger | Effect |
|---|---|---|
| `pause` | 3/3 governance approval + timelock | Stops `stake`, `unstake`, `claim_rewards`, `swap`, `add_liquidity`, `remove_liquidity`, `create_pool`, `flash_loan`, and `fund_reward_vault` |
| `unpause` | 3/3 governance approval + timelock | Resumes normal operations |
| `emergency_unstake` | Protocol paused | Users withdraw 100% of staked principal, forfeiting accrued `pending_rewards` |
| `emergency_remove_liquidity` | Protocol paused | LPs withdraw a proportional share of pool reserves |

---

## Security Model

### Multi-Layer Defence

```
Layer 1: Anchor Framework
  ├── Account ownership validation
  ├── PDA seed verification
  ├── Signer checks
  └── Rent exemption enforcement

Layer 2: Program Constraints
  ├── has_one = authority checks
  ├── token::mint / token::authority validation
  ├── Custom constraint macros (@ErrorCode)
  └── Bump validation via ctx.bumps

Layer 3: Business Logic
  ├── Pause/unpause gating
  ├── Multisig + timelock for governance
  ├── Invariant enforcement (AMM)
  ├── Slippage protection
  ├── Proportionality checks (liquidity)
  ├── Swap size limits
  └── Flash loan repayment validation

Layer 4: Arithmetic Safety
  ├── checked_add / checked_sub / checked_mul / checked_div
  ├── Custom Overflow / Underflow errors
  ├── No unchecked arithmetic anywhere
  └── Precision scaling (PRECISION = 10^18)

Layer 5: Frontend
  ├── Auto-ATA creation before every transaction
  ├── WSOL wrapping/unwrapping handled transparently
  ├── Balance checks before submission
  └── Comprehensive error parsing with friendly messages
```

### Custom Error Codes (30 total)

| Range | Category |
|---|---|
| 6000–6002 | Arithmetic (Overflow, Underflow, Unauthorised) |
| 6003–6004 | Admin state (Paused, NotInEmergencyMode) |
| 6005–6007 | Amounts (InvalidAmount, InsufficientBalance, Slippage) |
| 6008–6010 | AMM (NonProportionalLiquidity, InvariantViolation, InvalidMintOrder) |
| 6011–6015 | Staking (NoRewards, StakeAccountNotEmpty, InsufficientLiquidity, InsufficientStakeAmount, BelowMinimum) |
| 6016–6018 | Swap/Token (ExcessiveSwapAmount, InvalidFeeAmount, InvalidMint) |
| 6019–6023 | Governance (InsufficientSignatures, InvalidAction, TimelockNotExpired, InvalidTokenType, ProposalAlreadyActive) |
| 6024–6027 | Flash Loans (FlashLoanNotRepaid, FlashLoanTooLarge, InvalidCallbackProgram, UnapprovedCallbackProgram) |
| 6028–6029 | Multisig signers (InvalidMultisigSigner, DuplicateSigner) |

### What's Protected

| Attack Vector | Mitigation |
|---|---|
| Unauthorised admin actions | `has_one = authority` + multisig approval bitmap |
| Front-running governance | Timelock delay (set at initialization, bounded by `MAX_TIMELOCK_DELAY`) |
| Flash loan manipulation | Max 50% reserve + invariant check + approved callbacks only |
| Slippage exploitation | User-set minimum output amounts rejected on-chain |
| Dust staking attacks | Minimum stake threshold (1 SOL / 1,000 USDC) |
| Reward inflation | Time-capped accrual (24h max per update) |
| Pool imbalance | Proportionality checks with 0.1% tolerance |
| Infinite mint attacks | LP mint authority = pool PDA (no external key) |

---

## Frontend Application

Built with **Next.js 15 + React + Tailwind CSS** and integrated via `@solana/wallet-adapter`.

### User Experience Flow

```
Wallet Connect → My Portfolio (auto-populates) → Choose Operation Tab
                                                    ├── Stake (SOL + USDC cards)
                                                    ├── Unstake (SOL + USDC cards)
                                                    ├── Claim (Rewards + account mgmt)
                                                    ├── Swap (auto-slippage)
                                                    ├── Pool (info + advanced flash loan)
                                                    ├── Liquidity (add/remove + portfolio)
                                                    └── Admin (toggle → init/gov/state)
```

### UI Features

| Feature | Description |
|---|---|
| **My Portfolio** | Real-time display of staked SOL/USDC, pending rewards, LP tokens, pool share % |
| **Auto-wrap SOL** | All SOL operations auto-wrap to WSOL and create ATAs transparently |
| **Auto-ATA creation** | Every transaction auto-creates required Associated Token Accounts |
| **Slippage presets** | 0.5% / 1% / 3% quick-select with live min-output preview |
| **Pool data from chain** | Swap fee, flash loan fee, liquidity, callback program — all read live |
| **Protocol state dashboard** | 19 on-chain parameters displayed in real-time (admin) |
| **Emergency UI** | Emergency unstake/remove buttons visible during pause state |
| **Error parsing** | 30 custom error codes mapped to plain-English messages + on-chain log extraction |
| **Advanced mode** | Flash loan section collapsed behind developer toggle |
| **Idempotent initialisation** | USDC mint recovered from on-chain if localStorage is cleared |

---

## Project Structure

```
de-fi/
├── programs/de-fi/src/          # On-chain Anchor program
│   ├── lib.rs                   # Program entrypoint + instruction routing
│   ├── instructions/
│   │   ├── mod.rs
│   │   ├── admin.rs             # Governance, initialisation, vaults
│   │   ├── staking.rs           # Stake, unstake, claim, emergency
│   │   └── liquidity.rs         # Pool, swap, flash loan, liquidity
│   ├── state/
│   │   ├── mod.rs               # Constants, reward math
│   │   └── pool.rs              # ProgramState, Pool, UserStake structs
│   ├── errors.rs                # 30 custom error codes
│   └── events.rs                # Event emission types
├── app/                         # Next.js 15 frontend
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx         # Main application (all panels)
│   │   │   ├── layout.tsx       # Root layout with providers
│   │   │   └── globals.css      # Tailwind + custom glass styles
│   │   ├── hooks/
│   │   │   └── use-program.ts   # Anchor program connection hook
│   │   ├── lib/
│   │   │   └── pda.ts           # PDA derivation utilities
│   │   ├── providers/
│   │   │   └── solana-provider.tsx  # Wallet adapter + cluster config
│   │   └── idl/
│   │       └── defi.json        # Generated Anchor IDL
│   ├── package.json
│   └── next.config.ts
├── tests/
│   ├── de-fi.ts                 # Integration + security test suite
│   └── debug.js                 # Quick debugging scripts
├── migrations/
│   └── deploy.ts                # Anchor deployment hook
├── Anchor.toml                  # Anchor workspace configuration
├── Cargo.toml                   # Rust workspace
├── package.json                 # Root JS dependencies
├── tsconfig.json                # TypeScript configuration
└── README.md                    # This file
```

---

## Getting Started

### Prerequisites

- **Rust** (stable, 1.75+)
- **Solana CLI** (1.18+)
- **Anchor CLI** (0.30+)
- **Node.js** (20 LTS)
- **Yarn** (1.22+)

### Installation

```bash
# Clone the repository
git clone https://github.com/MuhKar1/Solana-Decentralised-Finance-Protocol.git
cd Solana-Decentralised-Finance-Protocol

# Install root dependencies
yarn install

# Install frontend dependencies
cd app && yarn install && cd ..

# Build the Anchor program
anchor build
```

### Running the Frontend

```bash
cd app
yarn dev
```

Open [http://localhost:3000](http://localhost:3000). Connect a Solana wallet (Phantom, Backpack, Solflare) set to **Devnet**.

### Running Tests

```bash
# Full test suite against local validator
anchor test

# TypeScript type checking only
cd app && npx tsc --noEmit
```

### Development Workflow

1. **Start local validator:** `solana-test-validator` (in separate terminal)
2. **Deploy program:** `anchor deploy`
3. **Run frontend:** `cd app && yarn dev`
4. **Run tests:** `anchor test`

---

## Testing

### Integration Tests (`tests/de-fi.ts`)

The TypeScript test suite validates:

| Category | Tests |
|---|---|
| **State initialisation** | Authority, signers, timelock, account creation |
| **SOL/USDC accounts** | PDA creation, vault setup, treasury initialisation |
| **Reward vault funding** | SOL wrapping, USDC minting, transfer validation |
| **Staking lifecycle** | Stake, unstake, reward accrual, claims |
| **AMM operations** | Pool creation, liquidity add/remove, swaps |
| **Governance** | Propose, approve, execute, cancel, timelock enforcement |
| **Security rejections** | Unauthorised access, below-minimum stakes, malformed swaps |
| **Emergency paths** | Pause/unpause, emergency unstake/withdraw |

### Frontend (TypeScript)

All 1,800+ lines of the frontend compile with **zero TypeScript errors** under strict mode.

---

## Deployment

### Devnet Deployment

```bash
anchor build
anchor deploy --provider.cluster devnet
```

Update the program ID in:
- `programs/de-fi/src/lib.rs` (`declare_id!`)
- `Anchor.toml` (`[programs.devnet]`)
- `app/src/providers/solana-provider.tsx` (`PROGRAM_ID`)

Rebuild the IDL after deployment:
```bash
anchor build
cp target/idl/defi.json app/src/idl/defi.json
```

### Frontend Deployment

```bash
cd app
yarn build
# Deploy the `out/` or `.next/` directory to Vercel / Netlify / Cloudflare Pages
```

---

## License & Disclaimer

This project is licensed under the [MIT License](./LICENSE).

**Disclaimer:** This software is provided for development, testing, and research purposes. Deploying financial smart contracts to public networks without independent security and economic review introduces material risk. No formal audit has been conducted. Use at your own risk.

---

<p align="center">
  <sub>Built with Anchor, Next.js, and Solana Web3</sub>
</p>