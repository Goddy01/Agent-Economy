# SKILLS.md - Agent Economy Wallet System

This file is written for AI agents operating within the Agent Economy colony. It defines the wallet API available to agents, the safety constraints that are enforced at the transaction layer, and the rules agents must follow. It also serves as context for AI coding assistants (like Cursor or Copilot).

---

## How the Colony Works

```
Funder (holds SOL + USDC reserves)
    -> tops up Pool and Traders on each tick

Traders
    -> read price from Oracle
    -> decide buy/sell against Pool via DEX adapter
    -> submit via TransactionEngine (simulate -> sign -> send)
    -> periodically send profit in USDC to Vault

Pool    - passive liquidity counterparty; does not initiate transactions
Vault   - treasury; receives USDC profit only; never sends
```

Every on-chain action can be accompanied by a Solana Memo log entry, creating a permanent, verifiable audit trail.

---

## Agent Capabilities

| Agent ID | Behavior | Tick Rate | Risk Level |
|---|---|---|---|
| `trader` | Spread + mean-reversion: buys when price below 24h avg, sells when above; only when spread exceeds threshold (see README / DEEP_DIVE) | 20s | Medium |
| `pool` | Liquidity reserve (SOL + USDC); passive counterparty | Event-driven, no tick | Passive |
| `funder` | Holds SOL + USDC reserves; distributes to pool and traders | 45s | Low |
| `vault` | Treasury; receives USDC profit from traders only | 60s | Locked |

---

## API Reference

### 1. Create / Register Agent Wallet

```typescript
const address = await walletManager.createWallet(agentId: string): Promise<string>
// Returns: Solana base58 public key
// Safe to call multiple times - idempotent
```

### 2. Get Wallet Balance

```typescript
const sol = await walletManager.getSolBalance(agentId: string): Promise<number>
const info = await walletManager.getWalletInfo(agentId: string): Promise<WalletInfo>
// WalletInfo includes: SOL balance + usdcBalance when USDC_MINT is set
// USDC is the platform stablecoin - required for full trading demo
```

### 3. Sign and Send a Transaction

```typescript
const result = await txEngine.executeTransaction(
  agentId: string,
  transaction: Transaction,
  description: string
): Promise<TransactionResult>

// TransactionResult:
// - success: boolean
// - signature?: string
// - simulationPassed: boolean
// - blockedBy?: string    <- circuit breaker message if blocked
// - dryRun: boolean
```

### 4. Build a SOL Transfer

```typescript
const tx = await walletManager.buildTransferTransaction(
  fromAgentId: string,
  toAddress: string,    // base58
  solAmount: number
): Promise<Transaction>
```

### 5. Log a Decision On-Chain

```typescript
const sig = await memoLogger.log(agentId: string, decision: AgentDecision): Promise<string | null>
// Writes decision as a Solana Memo instruction
// Permanent, publicly verifiable on Solscan
```

### 6. Request Devnet Airdrop (testing only)

```typescript
const sig = await walletManager.requestAirdrop(agentId: string, solAmount?: number)
// Max 2 SOL per call (devnet limitation)
// Use only in scripts or manual tests - never call from agent decision logic
// The funder does not auto-airdrop; send SOL to its wallet to top it up
```

---

## Safety Constraints

All transactions are routed through `TransactionEngine` (`src/transactions/TransactionEngine.ts`). These constraints are enforced at the engine level and cannot be bypassed by agent code.

| Constraint | Default | Env var |
|---|---|---|
| Rate limit per agent | 15 tx/min | `RATE_LIMIT_TX_PER_MINUTE` |
| Simulation before send | Always on | Not configurable |
| Dry run mode | Off | `DRY_RUN=true` |

### Critical rules for agents

**Never request private key bytes.** Agents sign by passing an `agentId` to the vault. Private key material never leaves `KeyVault` and is never returned to calling code.

**Always use `executeTransaction()`.** Do not build and send transactions directly. The engine is the only path that applies simulation, rate limiting, and dry run checks.

**Check `TransactionResult` before assuming success.** If `simulationPassed` is false or `blockedBy` is set, the transaction was not sent. Handle both cases.

**Do not call `requestAirdrop` from agent logic.** The funder agent distributes SOL from its own wallet balance. Top up the funder by sending devnet SOL to its address.

---

## Security Model

| Property | Implementation |
|---|---|
| Seed encryption at rest | AES-256-GCM + Argon2id in `.agent-colony-vault.json` |
| Key derivation | HD/BIP-44 path `m/44'/501'/{index}'/0'` - one index per agent |
| Key isolation | Compromise of one agent's key does not affect others |
| Key lifetime in memory | Derived only during signing; buffer zeroed immediately after |
| Agent interface | Agents call `sign({ agentId, transaction })` - no key bytes returned |

Traders are funded with **0.2 SOL + 10,000 USDC** at startup and whenever a new trader is added from the dashboard. The funder holds reserves and tops up the pool and traders automatically. Traders send profit to the vault in USDC.

---

## How to Add a New Agent

1. Extend `BaseAgent` (`src/agents/BaseAgent.ts`) and implement `decide()` and `execute()`
2. Register the agent ID with `vault.registerAgent(agentId)` in `src/vault/KeyVault.ts`
3. Set tick rate and config in `AgentConfig` (`src/colony/agentRegistry.ts`)
4. Add the agent to `Orchestrator` (`src/colony/Orchestrator.ts`) and wire any dashboard events

The agent's wallet is created automatically on first call to `walletManager.createWallet(agentId)`. No manual key generation needed.

---

For full setup instructions, environment variables, and on-chain verification steps, see [README.md](./README.md).
For wallet design, key derivation, and the security model in depth, see [DEEP_DIVE.md](./DEEP_DIVE.md).