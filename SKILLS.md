# SKILLS.md — Agent Colony Wallet System

**Per bounty requirement:** This file is for **AI agents** (e.g. Cursor, other code-assist agents) and **reviewers** to understand the agentic wallet API, safety constraints, and how to work with or extend the codebase.

## Overview

This system provides autonomous, multi-agent Solana wallet infrastructure for AI agents.
Each agent controls an independent HD-derived wallet with enforced safety constraints.

## Agent Capabilities

### Available Agents
| Agent ID       | Behavior              | Tick Rate | Risk Level |
|----------------|-----------------------|-----------|------------|
| `accumulator`  | Value buyer on dips   | 30s       | Low        |
| `flipper`      | Spread trader         | 10s       | Medium     |
| `vault`        | Treasury / receiving  | 60s       | Locked     |

---

## API Reference (for AI agents)

### 1. Create / Register Agent Wallet
```typescript
const address = await walletManager.createWallet(agentId: string): Promise<string>
// Returns: Solana base58 public key
// Safe to call multiple times — idempotent
```

### 2. Get Wallet Balance
```typescript
const sol = await walletManager.getSolBalance(agentId: string): Promise<number>
const info = await walletManager.getWalletInfo(agentId: string): Promise<WalletInfo>
// WalletInfo includes SOL + all SPL token balances
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
// Writes decision as Solana memo — permanent, verifiable on-chain record
```

### 6. Request Devnet Airdrop
```typescript
const sig = await walletManager.requestAirdrop(agentId: string, solAmount?: number)
// Max 2 SOL per call (devnet limitation)
```

---

## Safety Constraints (Enforced, Cannot Be Bypassed)

All transactions pass through `TransactionEngine` which enforces:

| Constraint             | Default  | Env Var                      |
|------------------------|----------|------------------------------|
| Max SOL per tx         | 0.5 SOL  | `MAX_TX_SOL`                 |
| Rate limit             | 10/min   | `RATE_LIMIT_TX_PER_MINUTE`   |
| Vault floor balance    | 5.0 SOL  | `VAULT_FLOOR_SOL`            |
| Simulation required    | Always   | Not configurable             |
| Dry run mode           | false    | `DRY_RUN=true`               |

---

## Security Model

- **Master seed**: Encrypted with AES-256-GCM + Argon2id at rest in `.vault.json`
- **Agent keys**: HD-derived (BIP-44, `m/44'/501'/{index}'/0'`) — compromise of one ≠ compromise of others
- **Key exposure**: Private keys only exist in memory during signing, zeroed immediately after
- **Agent interface**: Agents call `sign(request)` — they never receive private key bytes

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