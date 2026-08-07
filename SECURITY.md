# Security Architecture

## Overview

This document provides a comprehensive analysis of the security architecture of the Solana Decentralised Finance Protocol. Every security decision — from the choice of token standard to the multi-sig design — is documented with rationale.

---

## Why SPL Token (not Token-2022)?

The protocol uses the **standard SPL Token program** (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) rather than Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).

| Factor | SPL Token | Token-2022 | Protocol's Choice |
|---|---|---|---|
| **Maturity** | 5+ years, battle-tested | ~2 years | ✅ SPL Token |
| **Audit surface** | Audited by dozens of firms | Larger surface area | ✅ SPL Token |
| **Ecosystem compatibility** | Universal support | Some tools lag | ✅ SPL Token |
| **Confidential transfers** | Not available | Available | Not needed |
| **Transfer hooks** | Not available | Available | Not needed |
| **Permanent delegate** | Not available | Available | ❌ Security risk |
| **Metadata** | Not available | Available | Not needed |

### Detailed Rationale

**1. Attack Surface Minimisation**
Token-2022 introduces 25+ extension types including confidential transfers, transfer hooks, permanent delegate, and metadata. Each extension increases the attack surface. The protocol does not require any of these features — it only needs basic minting, burning, and transferring of tokens.

**2. Audit Maturity**
The standard SPL Token program is the most audited Solana program in existence. Token-2022, while formally verified for its core logic, has a larger untested extension surface. Protocols like Marinade, Jito, and Orca all continue to use standard SPL Token.

**3. No External Dependencies**
Token-2022's `transfer_hook` extension enables programs to intercept token transfers. While powerful, this introduces an external call during every transfer — a vector for re-entrancy and composability issues. The protocol achieves its goals without this complexity.

**4. WSOL Compatibility**
The protocol wraps native SOL into Wrapped SOL (WSOL) for DeFi operations. WSOL uses the standard SPL Token mint `So11111111111111111111111111111111111111112` which is on the standard SPL Token program. This is the universally accepted WSOL on Solana.

**5. Ecosystem Integration**
Every wallet (Phantom, Backpack, Solflare), every DEX aggregator (Jupiter), and every infrastructure provider (Helius, Triton) is optimised for standard SPL Token. Using standard SPL ensures maximum compatibility with no edge cases.

---

## Architecture-Level Security

### Why Anchor Framework?

The Anchor framework was chosen over raw Solana program development for the following security properties:

| Property | Without Anchor | With Anchor |
|---|---|---|
| Account ownership validation | Manual, error-prone | Automatic via `#[account]` |
| PDA seed verification | Manual derivation | `seeds = [...]` macro with bump |
| Signer checks | Manual `if !ctx.accounts.user.is_signer` | `Signer<'info>` type guarantees |
| Rent exemption | Manual check | Automatic for `init` accounts |
| Discriminator checks | Manual (8 bytes) | Built into Anchor account types |
| Instruction data deserialization | Manual Borsh/byte manipulation | Automatic via `#[derive(AnchorSerialize, AnchorDeserialize)]` |
| Cross-program invocation safety | Manual account ordering | Anchor's CPI context types |

### Account Model & PDA Architecture

All protocol accounts use **Program Derived Addresses (PDAs)**. This ensures:

1. **No private key exists** for vault accounts — funds can only be moved by program logic
2. **Deterministic addresses** prevent spoofing — users can verify account addresses independently
3. **Seed-based access control** — PDAs are derived from known inputs (user pubkey, token type, pool mints)

```
Program State:   PDA(["state"])
Staking Pool:    PDA(["staking_pool_sol"]) or PDA(["staking_pool_usdc"])
Reward Vault:    PDA(["reward_vault_sol"]) or PDA(["reward_vault_usdc"])
Treasury:        PDA(["protocol_treasury", mint_address])
User Stake:      PDA(["user_stake", user_pubkey, [token_type]])
Pool:            PDA(["pool", token_a_mint, token_b_mint])
Pool Vaults:     PDA(["pool_token_a", pool_pda]) and PDA(["pool_token_b", pool_pda])
LP Mint:         PDA(["lp_token_mint", pool_pda])
```

### Why Not a Separate Program per Domain?

Many protocols split governance, staking, and AMM into separate deployed programs. This protocol uses a **monolithic deployment** for the following reasons:

| Factor | Monolithic | Multi-Program |
|---|---|---|
| CPI overhead | Lower (same program invokes itself) | Higher (cross-program invocations) |
| Atomic state updates | Natural (single transaction) | Requires careful ordering |
| State sharing | Direct (same ProgramState) | Requires PDA lookup across programs |
| Upgrade coordination | Single upgrade | Multi-program upgrade dance |
| Audit scope | Single auditable unit | Multiple audit boundaries |
| Composable innovation | Harder to extend externally | Easier for external integration |

**Why monolithic is correct here:** This is a vertically-integrated protocol where staking rewards interact with governance (reward rate updates), liquidity interacts with flash loans (same pool vaults), and pause affects all domains simultaneously. A monolithic architecture avoids the composability risks of cross-program calls for internal operations.

---

## Access Control Model

### Multi-Signature Governance

The protocol uses a **3-of-3 multi-sig** with **timelock enforcement**:

```
                  ┌─────────────────────────────────────┐
                  │         PROPOSE (any signer)          │
                  │   encode action_type + data           │
                  └──────────────┬──────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   APPROVE (signers 2,3)  │
                    │   Track in [bool;3]       │
                    │   bitmap                 │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  TIMELOCK CHECK (24h)    │
                    │  Clock::get() >=          │
                    │  proposed_at + delay      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  EXECUTE (any signer)    │
                    │  Action takes effect     │
                    └──────────────────────────┘
```

### Why 3-of-3 with Timelock?

- **3-of-3** eliminates single points of failure — one compromised key cannot act alone
- **Timelock (24h default)** creates a window for detection and response to malicious proposals
- The number 3 is the minimum viable multi-sig while being practical for coordination
- Some protocols use 2-of-3 or M-of-N, but 3-of-3 provides the strongest security for admin operations since none of these operations need to be fast

### Signer Immutability

Once set at `initialize_state`, the 3 signer public keys **cannot be changed**. This is intentional:

1. **No `update_signer` function exists** — prevents privilege escalation attacks
2. **If a signer key is lost**, the protocol requires re-deployment with a new ProgramState
3. **Signers are visible on-chain** in the `ProgramState` account (offsets 40-136)

### Pause Control

The protocol has a **pause/unpause** mechanism governed by multi-sig:

| State | What's Blocked | What's Allowed |
|---|---|---|
| **PAUSED** | stake, unstake, swap, add_liquidity, remove_liquidity | emergency_unstake, emergency_remove_liquidity, admin operations, claim_rewards |
| **ACTIVE** | emergency withdrawal paths | All operations |

**Rationale:** Pause is a circuit-breaker. When activated, users retain full ability to withdraw their funds — only new deposits and trades are halted. This prevents "rug pull via pause" attacks where admins lock user funds.

---

## Economic Security

### Reward Calculation

```
reward_per_token = reward_per_token + (reward_rate × time_elapsed  / total_staked)

user_reward = user_stake × reward_per_token / PRECISION - reward_per_token_paid
```

**Protections:**

| Attack | Mitigation |
|---|---|
| **Reward inflation via time manipulation** | Time capped at 24h per `update_global_rewards` call |
| **Reward extraction without stake** | `user_stake.staked_amount > 0` gate on rewards |
| **Dust staking attacks** | `MIN_STAKE_AMOUNT = 1_000_000_000` (1 SOL / 1,000 USDC) |
| **Precision loss** | `PRECISION = 10^18` scaling factor |
| **Integer overflow** | `checked_add`/`checked_mul`/`checked_div` on all arithmetic |

### AMM Invariant Protection

```
k_before = reserve_a × reserve_b
k_after  = reserve_a' × reserve_b'
assert(k_after >= k_last)
```

**Protections:**

| Attack | Mitigation |
|---|---|
| **Swap manipulation** | Post-swap invariant ≥ pre-swap k_last |
| **Swap size exploitation** | Max 10% of reserve side per swap |
| **Flash loan theft** | Post-loan invariant ≥ pre-loan + fee |
| **LP dilution** | `MINIMUM_LIQUIDITY = 1,000` tokens locked forever |
| **Proportionality abuse** | ±0.1% tolerance on liquidity additions |
| **Pool key collision** | `token_a < token_b` enforced deterministically |

### Flash Loan Security

```
Loan ≤ 50% of vault reserve
Callback program must be approved via governance
Callback deadline: 60 seconds
Post-loan invariant must cover fee
```

---

## Arithmetic Safety

Every mathematical operation in the program uses Solana's checked arithmetic:

```rust
// ✅ Safe — reverts on overflow
amount.checked_add(other).ok_or(ErrorCode::Overflow)?

// ❌ Never used — panics on overflow
amount + other
```

**Custom error codes** for all arithmetic failures:
- `6000`: Overflow
- `6001`: Underflow

This means **no arithmetic panic can occur on-chain** — every operation either succeeds or returns a graceful error.

---

## Frontend Security

| Layer | Measure |
|---|---|
| **Wallet adapter** | Uses `@solana/wallet-adapter-react` — messages signed by wallet, not plaintext keys |
| **Transaction building** | Auto-creates ATAs before CPI calls, preventing "account not found" errors |
| **WSOL wrapping** | Auto-wraps native SOL before token operations, transparent to user |
| **Error parsing** | Extracts on-chain error codes and logs, maps to plain-English messages |
| **Simulation handling** | Gracefully handles `SendTransactionError` with `getLogs()` extraction |
| **Blockhash expiry** | Friendly message for expired blockhashes (common on mobile wallets) |
| **No key storage** | No private keys or mnemonics stored in frontend state |

---

## Known Limitations & Production Readiness

| Area | Current State | Path to Production |
|---|---|---|
| **Formal audit** | Not conducted | Third-party audit (OtterSec, Neodyme, or similar) required |
| **Economic modelling** | Not included | Fee calibration, liquidity stress tests, adversarial market simulations |
| **Fuzz/property testing** | Not included | Add property tests for swap invariants, reward arithmetic, flash loan repayment |
| **Bug bounty** | Not established | Launch on Immunefi or similar platform |
| **Deployer key management** | Single authority key | Multi-sig deployer (Squads or similar) for program upgrades |
| **Mainnet deployment** | Devnet only | Requires governance operations playbook, monitoring, alerting |

---

## Security Contacts

For security vulnerabilities, please refer to the repository's security policy. Do not disclose vulnerabilities publicly before they are addressed.

---

<p align="center">
  <sub>Last updated: July 2026</sub>
</p>