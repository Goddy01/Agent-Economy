# SKILLS.md  - Agent Economy Wallet System

**Per bounty requirement:** This file is for **AI agents** (e.g. Cursor, other code-assist agents) and **reviewers** to understand the agentic wallet API, safety constraints, and how to work with or extend the codebase.

## Overview

This system provides autonomous, multi-agent Solana wallet infrastructure for AI agents.
Each agent controls an independent HD-derived wallet with enforced safety constraints.

### Typical flow

Funder holds SOL and USDC reserves and tops up the pool and traders. Traders get price from the oracle, decide buy/sell against the pool via the DEX adapter, and submit transactions through the TransactionEngine (simulate → sign → send). Traders periodically send profit in USDC to the vault. The pool is a passive liquidity counterparty; the vault only receives and does not send. All on-chain decisions can be logged via the memo program.

## Agent Capabilities

### Available Agents


| Agent ID | Behavior                               | Tick Rate | Risk Level |
| -------- | -------------------------------------- | --------- | ---------- |
| `trader` | Spread trader (trades with pool)       | 20s       | Medium     |
| `pool`   | Liquidity reserve (SOL and USDC)       | -         | Passive    |
| `funder` | Holds SOL and USDC reserves; distributes to pool and traders | 45s | Low |
| `vault`  | Treasury; receives profit in USDC from traders | 60s   | Locked     |


---

## API Reference (for AI agents)

### 1. Create / Register Agent Wallet

```typescript
const address = await walletManager.createWallet(agentId: string): Promise<string>
// Returns: Solana base58 public key
// Safe to call multiple times  - idempotent
```

### 2. Get Wallet Balance

```typescript
const sol = await walletManager.getSolBalance(agentId: string): Promise<number>
const info = await walletManager.getWalletInfo(agentId: string): Promise<WalletInfo>
// WalletInfo includes SOL and usdcBalance when USDC_MINT is set (USDC is the platform stablecoin; required for full demo)
```

### 3. Sign and Send Transaction

```typescript
const result = await txEngine.executeTransaction(
  agentId: string,
  transaction: Transaction,
  description: string
): Promise<TransactionResult>

// TransactionResult includes:
// - success: boolean
// - signature?: string
// - simulationPassed: boolean
// - blockedBy?: string  ← circuit breaker message if blocked
// - dryRun: boolean
```

### 4. Build a Transfer

```typescript
const tx = await walletManager.buildTransferTransaction(
  fromAgentId: string,
  toAddress: string,    // base58
  solAmount: number
): Promise<Transaction>
```

### 5. Log Decision On-Chain

```typescript
const sig = await memoLogger.log(agentId: string, decision: AgentDecision): Promise<string | null>
// Writes decision as Solana memo  - permanent, verifiable on-chain record
```

### 6. Request Devnet Airdrop (manual devnet testing only)

```typescript
const sig = await walletManager.requestAirdrop(agentId: string, solAmount?: number)
// Max 2 SOL per call (devnet limitation)
```

The **funder agent** does not auto-request airdrops; it only distributes SOL that you send to its wallet. Use this API only for manual devnet top-ups (e.g. scripts or one-off tests), not from agent logic.

---

## Safety Constraints (Enforced, Cannot Be Bypassed)

All transactions pass through `TransactionEngine` which enforces:


| Constraint          | Default | Env Var                    |
| ------------------- | ------- | -------------------------- |
| Rate limit          | 15/min  | `RATE_LIMIT_TX_PER_MINUTE` |
| Simulation required | Always  | Not configurable           |
| Dry run mode        | false   | `DRY_RUN=true`             |

### Do not (for agents)

- **Do not** expect or request private key bytes — agents never receive them; they call the vault to sign by agent ID only.
- **Do not** bypass the TransactionEngine — all transactions must go through `executeTransaction()` so simulation and rate limits apply.
- **Do not** assume a transaction will be sent if simulation fails or the rate limit is hit; check `TransactionResult.simulationPassed` and `blockedBy`.
- **Do not** use `requestAirdrop` from within agent decision logic; the funder does not airdrop — send SOL to the funder wallet to top up.

---

## Security Model

- **Master seed**: Encrypted with AES-256-GCM + Argon2id at rest in `.agent-colony-vault.json`
- **Agent keys**: HD-derived (BIP-44, `m/44'/501'/{index}'/0'`)  - compromise of one ≠ compromise of others
- **Key exposure**: Private keys only exist in memory during signing, zeroed immediately after
- **Agent interface**: Agents call `sign(request)`  - they never receive private key bytes

Traders are funded with 0.2 SOL and 10k USDC at startup and when added from the dashboard. The funder holds SOL and USDC reserves and tops up the pool and traders. Traders send profit to the vault in USDC.

## How to Add a New Agent

1. Extend `BaseAgent` and implement `decide()` and `execute()`
2. Register agent ID with `vault.registerAgent(agentId)`
3. Configure tick rate in `AgentConfig`
4. Add to `Orchestrator` and wire dashboard events

## Environment Setup

```bash
cp .env.example .env
# Set MASTER_PASSPHRASE (32+ chars) and SOLANA_RPC_URL
npm install
npm run setup     # Initializes vault, airdrops devnet SOL
npm run start     # Launch colony with dashboard
```

